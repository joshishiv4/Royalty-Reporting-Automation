import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseSessionList, writeSessionList } from '../src/sync/sessions.js';

const K_BUSINESS = '111111';

/** Verbatim shape from the live /v1/schedule/class/list probe, 25 Aug 2026. */
function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    k_class_period: '18448467',
    k_class: '268302',
    k_location: '244238',
    dt_date: '2026-08-19 15:00:00',
    dtl_date: '2026-08-19 11:00:00',
    dt_time: '15:00:00',
    text_timezone: 'ET',
    s_title: 'A Joyful Noise | 60 Minutes',
    i_duration: 60,
    i_capacity: 10,
    i_book: 2,
    i_wait: 0,
    // WL sends these as STRINGS on this endpoint, not booleans.
    is_event: '0',
    is_cancel: '0',
    is_virtual: true,
    is_wait_list_enabled: true,
    url_book: 'https://example.invalid/book?k_class_period=18448467',
    a_staff: ['868220'],
    a_staff_uid: ['63746599'],
    ...overrides,
  };
}

function body(list: unknown[]): unknown {
  return { a_session: list, a_calendar: {}, status: 'ok' };
}

function response(b: unknown): WlResponse<unknown> {
  return { body: b, traceId: 'sc.1', kLog: null, httpStatus: 200, latencyMs: 12 };
}

describe('parseSessionList', () => {
  it('maps an occurrence, keeping every booking field', () => {
    const [s] = parseSessionList(body([session()]), K_BUSINESS).sessions;
    expect(s).toMatchObject({
      k_period: '18448467',
      dt_start_utc: '2026-08-19 15:00:00',
      k_class: '268302',
      session_kind: 'class',
      i_capacity: 10,
      i_booked: 2,
      i_wait: 0,
      is_wait_list_enabled: true,
      url_book: 'https://example.invalid/book?k_class_period=18448467',
    });
  });

  // THE TRAP THE TICKET IS ABOUT. One class id, six weeks. Keyed on the id alone
  // this collapses to a single row and five weeks of teaching vanish.
  it('keeps every weekly occurrence of ONE class id as its own row', () => {
    const weeks = [
      '2026-08-19 15:00:00',
      '2026-08-26 15:00:00',
      '2026-09-02 15:00:00',
      '2026-09-09 15:00:00',
      '2026-09-16 15:00:00',
      '2026-09-23 15:00:00',
    ].map((dt_date) => session({ dt_date, dtl_date: dt_date }));

    const { sessions } = parseSessionList(body(weeks), K_BUSINESS);

    expect(sessions).toHaveLength(6);
    expect(new Set(sessions.map((s) => s.k_period)).size).toBe(1);
    expect(new Set(sessions.map((s) => s.dt_start_utc)).size).toBe(6);
  });

  // Local time is WL's, not ours. Recomputing it from UTC would disagree with
  // what the studio sees across a DST boundary.
  it('stores the local time WL sent, never re-derived from the UTC one', () => {
    const [s] = parseSessionList(body([session()]), K_BUSINESS).sessions;
    expect(s?.dtl_start_local).toBe('2026-08-19 11:00:00');
    expect(s?.dt_start_utc).toBe('2026-08-19 15:00:00');
    expect(s?.text_timezone).toBe('ET');
  });

  it('reads WL\'s string "0"/"1" flags as booleans', () => {
    const plain = parseSessionList(body([session()]), K_BUSINESS).sessions[0];
    expect(plain?.is_event).toBe(false);
    expect(plain?.is_cancelled_studio).toBe(false);

    const flagged = parseSessionList(body([session({ is_event: '1', is_cancel: '1' })]), K_BUSINESS)
      .sessions[0];
    expect(flagged?.is_event).toBe(true);
    expect(flagged?.is_cancelled_studio).toBe(true);
  });

  it('pairs a_staff with a_staff_uid positionally', () => {
    const { staff, staffUids } = parseSessionList(
      body([session({ a_staff: ['868220', '350119'], a_staff_uid: ['63746599', '34714494'] })]),
      K_BUSINESS,
    );
    expect(staff).toEqual([
      expect.objectContaining({ k_staff: '868220', uid: '63746599' }),
      expect.objectContaining({ k_staff: '350119', uid: '34714494' }),
    ]);
    expect(staffUids).toEqual(['63746599', '34714494']);
  });

  it('keeps a staff assignment whose uid WL omitted, rather than dropping it', () => {
    const { staff } = parseSessionList(
      body([session({ a_staff: ['868220'], a_staff_uid: [] })]),
      K_BUSINESS,
    );
    expect(staff).toEqual([expect.objectContaining({ k_staff: '868220', uid: null })]);
  });

  // WL mixes a malformed entry into the list - observed live carrying a dtl_date
  // and nothing else. It cannot be keyed, so it must not become a half-row.
  it('skips and counts a record with no class period', () => {
    const { sessions, skipped } = parseSessionList(
      body([session(), { dtl_date: '2026-09-07 00:00:00' }]),
      K_BUSINESS,
    );
    expect(sessions).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('collects distinct location keys for the stub upsert', () => {
    const { locationKeys } = parseSessionList(
      body([session(), session({ dt_date: '2026-08-26 15:00:00' })]),
      K_BUSINESS,
    );
    expect(locationKeys).toEqual(['244238']);
  });

  it('returns nothing for a bare body', () => {
    expect(parseSessionList({}, K_BUSINESS).sessions).toEqual([]);
  });
});

describe('writeSessionList', () => {
  function fakeDb() {
    const calls: Array<{
      op: string;
      table: string;
      rows?: unknown[];
      options?: { onConflict?: string } | undefined;
    }> = [];
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-sc' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], options?: { onConflict?: string }) => {
        calls.push({ op: 'upsert', table, rows, options });
        return Promise.resolve(rows);
      }),
      update: vi.fn(() => Promise.resolve([])),
      select: vi.fn(() => Promise.resolve([])),
    };
    return { db: db as unknown as SupabaseClient, calls };
  }

  const input = (b: unknown) => ({
    kBusiness: K_BUSINESS,
    response: response(b),
    runId: 'run-1',
    windowKey: '2026-08-18|2026-09-24',
  });

  it('upserts occurrences on class AND date, so a re-run changes no row count', async () => {
    const { db, calls } = fakeDb();
    await writeSessionList(db, input(body([session()])));

    const upsert = calls.find((c) => c.op === 'upsert' && c.table === 'session');
    expect(upsert?.options?.onConflict).toBe('k_period,dt_start_utc');
  });

  // FK order: the session references location, and session_staff references
  // person. A real key that is not in those tables would reject the whole batch.
  it('writes location and person stubs BEFORE the session that references them', async () => {
    const { db, calls } = fakeDb();
    await writeSessionList(db, input(body([session()])));

    const order = calls.filter((c) => c.op === 'upsert').map((c) => c.table);
    expect(order.indexOf('location')).toBeLessThan(order.indexOf('session'));
    expect(order.indexOf('person')).toBeLessThan(order.indexOf('session'));
  });

  it('links every occurrence to the payload by its composite key', async () => {
    const { db, calls } = fakeDb();
    await writeSessionList(
      db,
      input(body([session(), session({ dt_date: '2026-08-26 15:00:00' })])),
    );

    const link = calls.find((c) => c.table === 'raw_link');
    expect(link?.rows).toHaveLength(2);
    expect(link?.rows?.[0]).toMatchObject({ record_key: '18448467|2026-08-19 15:00:00' });
  });

  it('stores the payload even when the window held no sessions', async () => {
    const { db, calls } = fakeDb();
    const result = await writeSessionList(db, input(body([])));

    expect(result.sessionCount).toBe(0);
    expect(calls.some((c) => c.table === 'raw_wl')).toBe(true);
    expect(calls.some((c) => c.op === 'upsert')).toBe(false);
  });

  it('reports how many malformed records were skipped', async () => {
    const { db } = fakeDb();
    const result = await writeSessionList(
      db,
      input(body([session(), { dtl_date: '2026-09-07 00:00:00' }])),
    );
    expect(result).toMatchObject({ sessionCount: 1, staffCount: 1, skipped: 1 });
  });
});
