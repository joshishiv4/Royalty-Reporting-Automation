import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseAttendanceList, writeAttendanceList } from '../src/sync/attendance.js';

const K_BUSINESS = '111111';
const K_PERIOD = '18448467';
const DT_START = '2026-08-19 15:00:00';

/** Verbatim shape from the live /v1/login/attendance/list probe, 25 Aug 2026. */
function attendee(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: '36453398',
    k_visit: '754626261',
    is_visit: true,
    is_attend: true,
    is_wait: false,
    is_truancy: false,
    is_unpaid: false,
    is_penalty: false,
    dt_book: '2026-07-10 20:20:04',
    uid_book: '58341479',
    k_location: '244238',
    s_firstname: 'Payam',
    s_lastname: 'Eftekharzadeh',
    text_visit_status_class: 'attend',
    ...overrides,
  };
}

function body(lists: Record<string, unknown[]>): unknown {
  return {
    a_list_active: [],
    a_list_confirm: [],
    a_list_wait: [],
    i_capacity: 10,
    i_client: 2,
    status: 'ok',
    ...lists,
  };
}

function response(b: unknown): WlResponse<unknown> {
  return { body: b, traceId: 'at.1', kLog: null, httpStatus: 200, latencyMs: 30 };
}

const parse = (b: unknown) => parseAttendanceList(b, K_PERIOD, DT_START, K_BUSINESS);

describe('parseAttendanceList', () => {
  it('maps an attendee onto the occurrence it belongs to', () => {
    const [r] = parse(body({ a_list_active: [attendee()] })).rows;
    expect(r).toEqual({
      k_period: K_PERIOD,
      dt_start_utc: DT_START,
      uid: '36453398',
      k_business: K_BUSINESS,
      k_visit: '754626261',
      dt_booked_utc: '2026-07-10 20:20:04',
      // No dt_register on this fixture: no check-in was recorded, which is not
      // the same as not attending. See 0030.
      dt_checkin_utc: null,
      // Null, not '3': this fixture carries no id_visit, and inferring the
      // attendance from is_visit must not invent a status WL never sent.
      id_visit: null,
      is_attended: true,
      is_no_show: false,
      is_cancelled_client: false,
      is_late_cancel: false,
      is_waitlisted: false,
      is_unpaid: false,
      uid_book: '58341479',
    });
  });

  // Live, ten of twelve records carry this. A royalty on an unpaid booking is a
  // different claim from one on a paid booking.
  it('records an unpaid booking as unpaid and NOT attended', () => {
    const [r] = parse(
      body({
        a_list_active: [
          attendee({
            is_visit: false,
            is_attend: false,
            is_unpaid: true,
            text_visit_status_class: 'Booked',
          }),
        ],
      }),
    ).rows;
    expect(r?.is_unpaid).toBe(true);
    // NULL, not false. WL sent no status and no attendance flag, so nothing here
    // says the client failed to turn up - only that we do not know yet. false is
    // a claim, and this is the column a royalty is paid from (migration 0029).
    expect(r?.is_attended).toBeNull();
  });

  it("reads WL's is_truancy as a no-show", () => {
    const [r] = parse(
      body({ a_list_active: [attendee({ is_visit: false, is_attend: false, is_truancy: true })] }),
    ).rows;
    expect(r?.is_no_show).toBe(true);
  });

  // Someone queued for a place is not in the class. Folding them in with the
  // booked attendees would overstate every capacity figure.
  it('flags the waiting list rather than counting it as attendance', () => {
    const { rows } = parse(body({ a_list_wait: [attendee({ uid: '999', is_visit: false })] }));
    expect(rows).toEqual([expect.objectContaining({ uid: '999', is_waitlisted: true })]);
  });

  it('reads all three lists in one pass', () => {
    const { rows } = parse(
      body({
        a_list_active: [attendee({ uid: '1' })],
        a_list_confirm: [attendee({ uid: '2' })],
        a_list_wait: [attendee({ uid: '3' })],
      }),
    );
    expect(rows.map((r) => r.uid).sort()).toEqual(['1', '2', '3']);
    expect(rows.find((r) => r.uid === '3')?.is_waitlisted).toBe(true);
  });

  // The lists can overlap. Booked beats waiting, or a promoted attendee would be
  // filed as still queuing.
  it('lets the booked entry win when a person is on two lists', () => {
    const { rows } = parse(
      body({
        a_list_wait: [attendee({ uid: '7' })],
        a_list_active: [attendee({ uid: '7' })],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_waitlisted).toBe(false);
  });

  it('collects attendee uids for the person stub', () => {
    const { uids } = parse(
      body({ a_list_active: [attendee({ uid: '1' }), attendee({ uid: '2' })] }),
    );
    expect(uids).toEqual(['1', '2']);
  });

  it('skips and counts an entry with no uid', () => {
    const { rows, skipped } = parse(
      body({ a_list_active: [attendee(), { s_firstname: 'Ghost' }] }),
    );
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('handles an empty class, which is a real answer not a failure', () => {
    expect(parse(body({})).rows).toEqual([]);
  });
});

describe('writeAttendanceList', () => {
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
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-at' }] : rows);
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
    kPeriod: K_PERIOD,
    dtStartUtc: DT_START,
    response: response(b),
    runId: 'run-1',
  });

  it('upserts on occurrence + person, so a re-run refreshes rather than duplicates', async () => {
    const { db, calls } = fakeDb();
    await writeAttendanceList(db, input(body({ a_list_active: [attendee()] })));

    const upsert = calls.find((c) => c.op === 'upsert' && c.table === 'attendance');
    expect(upsert?.options?.onConflict).toBe('k_period,dt_start_utc,uid');
  });

  // attendance.uid is NOT NULL with a real FK, and attendees are routinely people
  // the staff list never returns. Without the stub the whole batch is rejected.
  it('writes the person stub BEFORE the attendance that references it', async () => {
    const { db, calls } = fakeDb();
    await writeAttendanceList(db, input(body({ a_list_active: [attendee()] })));

    const order = calls.filter((c) => c.op === 'upsert').map((c) => c.table);
    expect(order.indexOf('person')).toBeLessThan(order.indexOf('attendance'));
  });

  it('counts how many actually attended', async () => {
    const { db } = fakeDb();
    const result = await writeAttendanceList(
      db,
      input(
        body({
          a_list_active: [
            attendee({ uid: '1' }),
            attendee({ uid: '2', is_visit: false, is_attend: false }),
          ],
        }),
      ),
    );
    expect(result).toMatchObject({ count: 2, attended: 1 });
  });

  it('stores the payload even for an empty class, and writes no rows', async () => {
    const { db, calls } = fakeDb();
    const result = await writeAttendanceList(db, input(body({})));

    expect(result.count).toBe(0);
    expect(calls.some((c) => c.table === 'raw_wl')).toBe(true);
    expect(calls.some((c) => c.op === 'upsert')).toBe(false);
  });
});

describe("WL's own visit status is what gets stored", () => {
  // The bug this covers: the parser derived attendance from is_visit/is_attend
  // and never wrote id_visit, so every row it produced left the column
  // session_outcome.is_countable depends on null - 4,431 of 4,431 on live dev.
  it('stores id_visit and derives the outcome from it', () => {
    const [row] = parse(body({ a_list_active: [attendee({ id_visit: 3 })] })).rows;
    expect(row?.id_visit).toBe('3');
    expect(row?.is_attended).toBe(true);
  });

  it('normalises the numeric code WL sends into text', () => {
    // A code is not arithmetic, and a leading zero is lost as an integer.
    expect(parse(body({ a_list_active: [attendee({ id_visit: 5 })] })).rows[0]?.id_visit).toBe('5');
  });

  it('reads TRUANCY as a no-show rather than a cancellation', () => {
    const [row] = parse(body({ a_list_active: [attendee({ id_visit: 5 })] })).rows;
    expect(row?.is_attended).toBe(false);
    expect(row?.is_no_show).toBe(true);
    expect(row?.is_cancelled_client).toBe(false);
  });

  it('reads PENALTY as a cancellation AND a late one', () => {
    const [row] = parse(body({ a_list_active: [attendee({ id_visit: 4 })] })).rows;
    expect(row?.is_cancelled_client).toBe(true);
    expect(row?.is_late_cancel).toBe(true);
    expect(row?.is_no_show).toBe(false);
  });

  it('reads CANCEL as a cancellation that was in time', () => {
    const [row] = parse(body({ a_list_active: [attendee({ id_visit: 6 })] })).rows;
    expect(row?.is_cancelled_client).toBe(true);
    expect(row?.is_late_cancel).toBe(false);
  });

  it.each([1, 2, 7, 8])('leaves is_attended unknown for status %i', (code) => {
    // BOOK, WAIT, PENDING and REMOVE carry no verdict. false would claim the
    // client did not turn up, in the column a royalty is paid from.
    const [row] = parse(body({ a_list_active: [attendee({ id_visit: code })] })).rows;
    expect(row?.is_attended).toBeNull();
    expect(row?.id_visit).toBe(String(code));
  });

  it('does not let the undocumented booleans override the status', () => {
    // is_visit/is_attend are true on this fixture. WL says TRUANCY. WL wins:
    // id_visit is the documented field, the booleans appear nowhere in the spec.
    const [row] = parse(body({ a_list_active: [attendee({ id_visit: 5 })] })).rows;
    expect(row?.is_attended).toBe(false);
    expect(row?.is_no_show).toBe(true);
  });

  it('falls back to the booleans only when no status is sent', () => {
    const [row] = parse(body({ a_list_active: [attendee()] })).rows;
    expect(row?.id_visit).toBeNull();
    expect(row?.is_attended).toBe(true);
  });

  it('reconstructs a late cancellation from is_penalty when the status is absent', () => {
    const [row] = parse(
      body({ a_list_active: [attendee({ is_penalty: true, is_visit: false, is_attend: false })] }),
    ).rows;
    expect(row?.is_cancelled_client).toBe(true);
    expect(row?.is_late_cancel).toBe(true);
  });

  it('says "not known" rather than "did not attend" when nothing indicates either', () => {
    const [row] = parse(
      body({ a_list_active: [attendee({ is_visit: false, is_attend: false })] }),
    ).rows;
    expect(row?.id_visit).toBeNull();
    expect(row?.is_attended).toBeNull();
  });

  it('treats id_visit 0 as absent and falls back, rather than storing "0"', () => {
    // Zero is not a valid WlVisitSid value, so it is not a status. The fixture's
    // is_visit still says they attended - and id_visit stays null, because WL
    // never actually stated one.
    const [row] = parse(body({ a_list_active: [attendee({ id_visit: 0 })] })).rows;
    expect(row?.id_visit).toBeNull();
    expect(row?.is_attended).toBe(true);
  });
});

describe('the check-in moment, which is not is_checkin', () => {
  it("stores WL's dt_register as the check-in time", () => {
    const [row] = parse(
      body({ a_list_active: [attendee({ dt_register: '2026-08-19 15:02:11' })] }),
    ).rows;
    expect(row?.dt_checkin_utc).toBe('2026-08-19 15:02:11');
  });

  it('leaves it null when WL recorded no check-in', () => {
    // The normal case for an appointment: that record shape carries id_visit but
    // no dt_register at all. Null here means "no check-in recorded", NOT "did
    // not attend" - attendance is id_visit = 3 and nothing derives from this.
    const [row] = parse(body({ a_list_active: [attendee({ id_visit: 3 })] })).rows;
    expect(row?.dt_checkin_utc).toBeNull();
    expect(row?.is_attended).toBe(true);
  });
});
