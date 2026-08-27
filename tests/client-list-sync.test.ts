import { describe, expect, it, vi } from 'vitest';
import {
  assertReportFields,
  groupByShape,
  mapClientRow,
  mapClientRows,
  writeClientList,
} from '../src/sync/clients.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import {
  ALL_DATES,
  buildReportBody,
  fetchAllReportRows,
  fetchReportPage,
  MEMBER_STATUS_ACTIVATED,
  pollReport,
  readAllReportRows,
  REPORT_PAGE_SIZE,
  requestReport,
} from '../src/wl/report.js';

/**
 * The client-list report (PRD M07). Two of these tests exist because the
 * behaviour they pin cost real measurement to discover, and both failure modes
 * are silent - the sync would report a clean run while being wrong.
 */

const K_BUSINESS = '111111';

/** The column ids this business's report actually returns, in order. */
/**
 * The field ids the live report returns, restricted to the ones that matter here.
 *
 * EVERY ID THIS SYNC MAPS MUST BE PRESENT. `writeClientList` now refuses a page
 * whose field list has stopped carrying one (see assertReportFields), because the
 * report is configured in the WL portal and a removed column would otherwise stop
 * writing that person column with no error at all. This fixture used to omit four
 * of them, which is exactly the state the guard exists to reject.
 *
 * `field-general-2.is_traveller` and `field-custom-378723` are deliberately kept:
 * they are ids the sync maps nothing to, and they must stay harmless.
 */
const FIELDS = [
  'k_login_type',
  'uid',
  'field-general-2.is_traveller',
  'field-general-2.text_name',
  'field-general-1',
  'field-general-3',
  'field-custom-378723',
  'field-general-4',
  'field-general-5',
  'field-general-6',
  'field-general-7.dl_date',
  'field-general-11',
  'text_client_type',
];

const ROW: Array<string | boolean | null> = [
  '1260510',
  '33793232',
  false,
  'Jared',
  'Feldman',
  'jared@spindjacademy.com',
  'secondary@example.com',
  '+15162720782',
  '+15162720783',
  '',
  '1985-04-11',
  'MEM-4471',
  'Staff Client Profile',
];

/** A WL client that answers `n` polls as queued, then completes. */
function fakeWl(pages: Array<readonly unknown[][]>, queuedPolls = 0) {
  const bodies: Array<Record<string, unknown>> = [];
  let polls = 0;
  const request = vi.fn((_path: string, options: { json?: unknown } = {}) => {
    const body = options.json as Record<string, unknown>;
    bodies.push(body);
    const queued = polls < queuedPolls;
    polls += 1;
    const offset = Number(body.i_offset ?? 0);
    const page = pages[offset / REPORT_PAGE_SIZE] ?? [];
    return Promise.resolve({
      body: {
        a_field: FIELDS,
        // A queued report returns rows that mean nothing. Returning the real
        // rows here would make the test pass for the wrong reason.
        a_row: queued ? [] : page,
        id_report_status: queued ? 2 : 3,
        dtu_complete: queued ? null : '2026-08-26 11:00:00',
      },
      traceId: 't1',
      kLog: null,
      httpStatus: 200,
      latencyMs: 5,
    });
  });
  return { wl: { request } as never, bodies, pollCount: () => polls };
}

const nosleep = { sleep: () => Promise.resolve() };

describe('the report is asynchronous, and says so only in id_report_status', () => {
  /**
   * Measured live: a filter matching nobody and a filter matching 229 people
   * BOTH returned 0 rows on the first call. Trusting that first answer would
   * store zero clients and report a successful run - a failure that looks
   * exactly like success.
   */
  it('waits for id_report_status 3 instead of trusting the first answer', async () => {
    const f = fakeWl([[ROW]], 2);
    const page = await fetchReportPage(f.wl, K_BUSINESS, {}, 0, nosleep);

    expect(f.pollCount()).toBe(3);
    expect(page.rows).toHaveLength(1);
  });

  // Only the first call may ask WL to rebuild. Asking again restarts the
  // report, so a polling loop that always sets is_refresh never converges.
  it('asks for a refresh once, then only reads', async () => {
    const f = fakeWl([[ROW]], 2);
    await fetchReportPage(f.wl, K_BUSINESS, {}, 0, nosleep);

    expect(f.bodies.map((b) => b.is_refresh)).toEqual([1, 0, 0]);
  });

  // A timeout must not be mistaken for an empty business.
  it('throws rather than returning a report that never finished', async () => {
    const f = fakeWl([[ROW]], 1_000);
    await expect(fetchReportPage(f.wl, K_BUSINESS, {}, 0, nosleep)).rejects.toThrow(
      /did not finish building/,
    );
  });
});

describe('the date window is mandatory and it excludes silently', () => {
  /**
   * WL rejects a body with no o_date (`end-date-not-set`), so there is no way
   * to say "no date filter". id_report_date 4 is CLIENT SINCE DATE, so the
   * window drops anyone who joined outside it: measured, a 2010..2026 window
   * returned 516 activated clients where the portal shows 517 - one client,
   * joined before 2010, missing with no error at all.
   */
  it('sends a window nobody can fall outside', () => {
    const body = buildReportBody(K_BUSINESS, {}, 0, false);
    const filter = body.json_filter as Record<string, unknown>;

    expect(filter.o_date).toEqual(ALL_DATES);
    expect(Number(ALL_DATES.dl_start.slice(0, 4))).toBeLessThanOrEqual(1900);
    expect(Number(ALL_DATES.dl_end.slice(0, 4))).toBeGreaterThanOrEqual(2100);
  });

  // WL misreads a partial filter object, so every key goes even when empty.
  it('sends every o_ key the collection sends, empty or not', () => {
    const filter = buildReportBody(K_BUSINESS, {}, 0, false).json_filter as Record<string, unknown>;

    for (const key of [
      'o_business_contract',
      'o_client_churn_risk',
      'o_client_type',
      'o_date',
      'o_gender',
      'o_liability_waiver',
      'o_location_home',
      'o_login_list',
      'o_member_group',
      'o_member_status',
      'o_member_subscribe',
      'o_promotion_special',
      'o_search',
      'o_search_template',
      'o_user_app',
    ]) {
      expect(filter).toHaveProperty(key);
    }
  });

  it('carries the requested member status through', () => {
    const filter = buildReportBody(
      K_BUSINESS,
      { memberStatuses: [MEMBER_STATUS_ACTIVATED] },
      0,
      false,
    ).json_filter as Record<string, unknown>;

    expect(filter.o_member_status).toEqual([3]);
  });

  // Measured 26 Aug 2026: [] returns all 1,285 clients, [3] returns 517. The
  // empty filter is how the pass asks for every status.
  it('sends an empty member-status filter to mean every status', () => {
    const filter = buildReportBody(K_BUSINESS, { memberStatuses: [] }, 0, false)
      .json_filter as Record<string, unknown>;

    expect(filter.o_member_status).toEqual([]);
  });
});

describe('single-shot request / poll / read (the non-blocking building blocks)', () => {
  it('requestReport starts a build with is_refresh=1 and does not loop', async () => {
    const f = fakeWl([[ROW]], 5); // would be "queued" for 5 polls
    await requestReport(f.wl, K_BUSINESS, {}, nosleep);
    // Exactly one call, and it asked WL to (re)build.
    expect(f.pollCount()).toBe(1);
    expect(f.bodies[0]!.is_refresh).toBe(1);
  });

  it('pollReport reads with is_refresh=0 and reports completion', async () => {
    const done = fakeWl([[ROW]], 0); // status 3 immediately
    expect(await pollReport(done.wl, K_BUSINESS, {}, nosleep)).toEqual({ complete: true });
    expect(done.bodies[0]!.is_refresh).toBe(0); // never restarts the build

    const building = fakeWl([[ROW]], 5); // status 2
    expect(await pollReport(building.wl, K_BUSINESS, {}, nosleep)).toEqual({ complete: false });
  });

  it('readAllReportRows walks every page with is_refresh=0 throughout', async () => {
    const full = Array.from({ length: REPORT_PAGE_SIZE }, () => ROW);
    const f = fakeWl([full, [ROW, ROW]]);
    const out = await readAllReportRows(f.wl, K_BUSINESS, {}, nosleep);
    expect(out.rowCount).toBe(REPORT_PAGE_SIZE + 2);
    // Crucially, NOT one is_refresh=1 - reading a built report must not restart it.
    expect(f.bodies.every((b) => b.is_refresh === 0)).toBe(true);
  });
});

describe('paging walks until a short page', () => {
  it('fetches every page and stops on the short one', async () => {
    const full = Array.from({ length: REPORT_PAGE_SIZE }, () => ROW);
    const f = fakeWl([full, [ROW, ROW]]);
    const out = await fetchAllReportRows(f.wl, K_BUSINESS, {}, nosleep);

    expect(out.rowCount).toBe(REPORT_PAGE_SIZE + 2);
    expect(out.pages).toHaveLength(2);
    expect(f.bodies.map((b) => b.i_offset)).toEqual([0, REPORT_PAGE_SIZE]);
  });

  it('stops after one page when the first is already short', async () => {
    const f = fakeWl([[ROW]]);
    const out = await fetchAllReportRows(f.wl, K_BUSINESS, {}, nosleep);

    expect(out.pages).toHaveLength(1);
  });
});

describe('columns are read by name, never by position', () => {
  /**
   * a_row is positional and the order comes from how the report is configured
   * in the WL portal. Reading row[5] because email sits there today would
   * silently write the wrong values the first time somebody adds a column.
   */
  it('still maps correctly when the columns are reordered', () => {
    const shuffled = [...FIELDS].reverse();
    const shuffledRow = [...ROW].reverse();

    expect(mapClientRow(shuffled, shuffledRow)).toEqual(mapClientRow(FIELDS, ROW));
  });

  it('maps the fields we actually rely on', () => {
    expect(mapClientRow(FIELDS, ROW)).toEqual({
      uid: '33793232',
      k_login_type: '1260510',
      first_name: 'Jared',
      last_name: 'Feldman',
      email: 'jared@spindjacademy.com',
      phone: '+15162720782',
      phone_home: '+15162720783',
      date_of_birth: '1985-04-11',
      text_member: 'MEM-4471',
      text_login_type: 'Staff Client Profile',
      // phone_work is ABSENT, not empty: the report sends '' for a field the
      // client never filled in, and an empty string is the absence of evidence,
      // not evidence the value was deleted. Merge, never clobber.
    });
  });

  // The business-specific field-custom-* columns are read by nothing, so
  // reconfiguring them in the portal cannot break the sync.
  it("ignores this business's custom fields entirely", () => {
    const mapped = mapClientRow(FIELDS, ROW);
    expect(Object.values(mapped ?? {})).not.toContain('secondary@example.com');
  });

  it('drops a column the report stopped returning rather than guessing', () => {
    const without = FIELDS.filter((f) => f !== 'field-general-3');
    const row = ROW.filter((_, i) => FIELDS[i] !== 'field-general-3');

    expect(mapClientRow(without, row)).not.toHaveProperty('email');
  });
});

describe('merge, never clobber', () => {
  // WL sends "" for a field the client has not filled in. That is the absence
  // of evidence, not evidence of absence - writing it would erase a value some
  // other endpoint established.
  it('omits an empty string instead of writing it over a known value', () => {
    const row = [...ROW];
    row[5] = '';
    const mapped = mapClientRow(FIELDS, row);

    expect(mapped).not.toHaveProperty('email');
  });

  it('omits a null the same way', () => {
    const row = [...ROW];
    row[7] = null;

    expect(mapClientRow(FIELDS, row)).not.toHaveProperty('phone');
  });

  it('trims, because WL pads some fields with tabs', () => {
    const row = [...ROW];
    row[3] = '  Jared\t';

    expect(mapClientRow(FIELDS, row)?.first_name).toBe('Jared');
  });
});

describe('a row with no uid is nobody', () => {
  it('drops a row carrying no uid rather than inventing one', () => {
    const row = [...ROW];
    row[1] = '';

    expect(mapClientRow(FIELDS, row)).toBeNull();
  });

  it('keeps one row per human when a uid repeats', () => {
    expect(mapClientRows(FIELDS, [ROW, ROW])).toHaveLength(1);
  });
});

describe('writeClientList stores the payload before the people', () => {
  function db() {
    const calls: Array<{ op: string; table: string; rows: unknown[] }> = [];
    return {
      calls,
      db: {
        insert: vi.fn((table: string, rows: unknown[]) => {
          calls.push({ op: 'insert', table, rows });
          return Promise.resolve([{ id: 'raw-1' }]);
        }),
        upsert: vi.fn((table: string, rows: unknown[]) => {
          calls.push({ op: 'upsert', table, rows });
          return Promise.resolve(rows);
        }),
      } as unknown as SupabaseClient,
    };
  }

  const page = {
    fields: FIELDS,
    rows: [ROW],
    response: { body: {}, traceId: 't', kLog: null, httpStatus: 200, latencyMs: 1 },
  } as never;

  it('writes raw_wl first, so the people can point at it', async () => {
    const h = db();
    await writeClientList(h.db, {
      kBusiness: K_BUSINESS,
      runId: 'r1',
      page,
      fields: FIELDS,
      syncedAt: 'now',
      activatedUids: new Set(['33793232']),
    });

    expect(h.calls[0]).toMatchObject({ op: 'insert', table: 'raw_wl' });
    expect(h.calls[1]).toMatchObject({ op: 'upsert', table: 'person' });
  });

  // 'identity' rather than 'all': this report establishes who somebody is and
  // nothing about their money, so a person assembled from two payloads can
  // trace each half.
  it('records that only the identity fields came from here', async () => {
    const h = db();
    await writeClientList(h.db, {
      kBusiness: K_BUSINESS,
      runId: 'r1',
      page,
      fields: FIELDS,
      syncedAt: 'now',
      activatedUids: new Set(['33793232']),
    });

    const link = h.calls.find((c) => c.table === 'raw_link');
    expect((link?.rows[0] as Record<string, unknown>).field_group).toBe('identity');
  });

  it('writes nobody, and links nothing, for an empty page', async () => {
    const h = db();
    await writeClientList(h.db, {
      kBusiness: K_BUSINESS,
      runId: 'r1',
      page: { ...(page as object), rows: [] } as never,
      fields: FIELDS,
      syncedAt: 'now',
      activatedUids: new Set(),
    });

    expect(h.calls.filter((c) => c.table === 'person')).toEqual([]);
    expect(h.calls.filter((c) => c.table === 'raw_link')).toEqual([]);
  });
});

describe('is_active is tagged from the activated set, not the row', () => {
  function db() {
    const upserts: Array<Array<Record<string, unknown>>> = [];
    return {
      upserts,
      db: {
        insert: vi.fn(() => Promise.resolve([{ id: 'raw-1' }])),
        upsert: vi.fn((_t: string, rows: unknown[]) => {
          upserts.push(rows as Array<Record<string, unknown>>);
          return Promise.resolve(rows);
        }),
      } as unknown as SupabaseClient,
    };
  }
  const page = {
    fields: FIELDS,
    rows: [ROW],
    response: { body: {}, traceId: 't', kLog: null, httpStatus: 200, latencyMs: 1 },
  } as never;

  it('marks a client in the activated set is_active true', async () => {
    const h = db();
    await writeClientList(h.db, {
      kBusiness: K_BUSINESS,
      runId: 'r1',
      page,
      fields: FIELDS,
      syncedAt: 'now',
      activatedUids: new Set(['33793232']),
    });
    expect(h.upserts[0]?.[0]?.is_active).toBe(true);
  });

  // The row's own type says "Staff Client Profile" and nothing about activation;
  // absence from the activated set is the ONLY thing that makes it false.
  it('marks a client absent from the activated set is_active false', async () => {
    const h = db();
    await writeClientList(h.db, {
      kBusiness: K_BUSINESS,
      runId: 'r1',
      page,
      fields: FIELDS,
      syncedAt: 'now',
      activatedUids: new Set(),
    });
    expect(h.upserts[0]?.[0]?.is_active).toBe(false);
  });
});

describe('sparse rows still go in batches', () => {
  /**
   * PostgREST builds one INSERT from the first object's columns and rejects the
   * rest - `PGRST102: All object keys must match`. That collides head-on with
   * merge-never-clobber, which produces deliberately sparse rows. Hit live on
   * the first real run: 517 clients, zero written.
   *
   * Filling the gaps with null is the clobber the sparseness exists to prevent;
   * one request per row is 517 round trips. Grouping keeps both properties.
   */
  it('puts rows with the same keys together', () => {
    const groups = groupByShape([
      { uid: '1', email: 'a@b.c' },
      { uid: '2', email: 'd@e.f' },
      { uid: '3' },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.flat()).toHaveLength(3);
  });

  it('does not care what order the keys were written in', () => {
    expect(
      groupByShape([
        { uid: '1', email: 'x' },
        { email: 'y', uid: '2' },
      ]),
    ).toHaveLength(1);
  });

  // The whole point: no row gains a key it did not have.
  it('never adds a key to fill a gap', () => {
    const groups = groupByShape([{ uid: '1', email: 'a@b.c' }, { uid: '2' }]);
    const lonely = groups.flat().find((r) => r.uid === '2');

    expect(lonely).not.toHaveProperty('email');
  });

  it('handles an empty list without producing an empty batch', () => {
    expect(groupByShape([])).toEqual([]);
  });
});

describe('writeClientList batches sparse people rather than failing', () => {
  it('splits one page into as many upserts as there are shapes', async () => {
    const upserts: Array<Array<Record<string, unknown>>> = [];
    const db = {
      insert: vi.fn(() => Promise.resolve([{ id: 'raw-1' }])),
      upsert: vi.fn((_t: string, rows: unknown[]) => {
        upserts.push(rows as Array<Record<string, unknown>>);
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;

    // Two clients, one with an email and one without: two shapes.
    const withEmail = [...ROW];
    const without = [...ROW];
    without[1] = '99999999';
    without[5] = '';

    await writeClientList(db, {
      kBusiness: K_BUSINESS,
      runId: 'r1',
      page: {
        fields: FIELDS,
        rows: [withEmail, without],
        response: { body: {}, traceId: 't', kLog: null, httpStatus: 200, latencyMs: 1 },
      },
      fields: FIELDS,
      syncedAt: 'now',
      activatedUids: new Set(),
    });

    expect(upserts).toHaveLength(2);
    for (const batch of upserts) {
      const shapes = new Set(batch.map((r) => Object.keys(r).sort().join(',')));
      expect(shapes.size).toBe(1);
    }
  });
});

describe('a field list that stopped carrying what we map fails the run', () => {
  // The failure this prevents: mapClientRow skips an id it does not recognise,
  // which is right for the field-custom-* columns nobody reads - but it makes
  // the reverse silent. A column renamed by WL, or removed from the report in
  // the portal, would simply stop being written while the pass reported ok.
  it('accepts the field list the live report actually returns', () => {
    expect(() => assertReportFields(FIELDS)).not.toThrow();
  });

  it('names every missing id, so the fix does not need a guess', () => {
    const without = FIELDS.filter((f) => f !== 'field-general-3' && f !== 'field-general-4');
    expect(() => assertReportFields(without)).toThrow(/field-general-3/);
    expect(() => assertReportFields(without)).toThrow(/field-general-4/);
  });

  it('refuses a list with no uid rather than writing zero clients', () => {
    // The worst case: without uid every row maps to null, mapClientRows drops
    // them all, and the pass stores nobody and reports success.
    expect(() => assertReportFields(FIELDS.filter((f) => f !== 'uid'))).toThrow(/uid/);
  });

  it('does not care about ids it maps nothing to', () => {
    const noCustom = FIELDS.filter((f) => !f.startsWith('field-custom-'));
    expect(() => assertReportFields(noCustom)).not.toThrow();
  });

  it('refuses the page before any client is written', async () => {
    const calls: Array<{ op: string; table: string }> = [];
    const stub = {
      insert: vi.fn((table: string, _rows: unknown[]) => {
        calls.push({ op: 'insert', table });
        // storeRawWl needs the new payload's id back to link rows to it.
        return Promise.resolve([{ id: 'raw-1' }]);
      }),
      upsert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'upsert', table });
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;

    await expect(
      writeClientList(stub, {
        kBusiness: K_BUSINESS,
        runId: 'r1',
        page: {
          fields: FIELDS,
          rows: [ROW],
          response: { body: {}, traceId: 't', kLog: null, httpStatus: 200, latencyMs: 1 },
        },
        fields: FIELDS.filter((f) => f !== 'field-general-4'),
        syncedAt: 'now',
        activatedUids: new Set(['33793232']),
      }),
    ).rejects.toThrow(/field-general-4/);

    // The payload is stored FIRST on purpose: whatever changed is then readable
    // from raw_wl without another WL call. But no person is touched.
    expect(calls.some((c) => c.table === 'raw_wl')).toBe(true);
    expect(calls.filter((c) => c.table === 'person')).toHaveLength(0);
  });
});
