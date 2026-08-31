import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import {
  parseVisitElement,
  parseVisitList,
  writeClientSession,
} from '../src/sync/client-sessions.js';

const K_BUSINESS = '111111';
const UID = '36453792';
const K_VISIT = '753909597';

/** A private appointment, verbatim from the live probe 25 Aug 2026. */
function appointment(overrides: Record<string, unknown> = {}): unknown {
  return {
    k_appointment: '132190448',
    k_class: null,
    k_class_period: null,
    k_service: '142544',
    k_location: '244238',
    dt_date_global: '2026-08-25 17:00:00',
    dt_date_local: '2026-08-25 13:00:00',
    text_timezone: 'ET',
    s_title: 'Music For Everyone | 60 Minutes',
    i_duration: 60,
    is_event: false,
    is_virtual: true,
    is_checkin: false,
    // WL calls this dt_cancel; it is a DEADLINE, exactly 24h before the start.
    dt_cancel: '2026-08-24 17:00:00',
    a_staff: [{ k_staff: '344486', s_name: 'Jared', s_name_full: 'Jared Feldman' }],
    // Booking-request state, nested exactly as WL sends it. All three were false
    // on 60 of 60 payloads measured.
    a_appointment_visit_info: {
      id_visit: 1,
      is_request: false,
      is_confirmed: false,
      is_deny: false,
      i_book_active: 1,
    },
    ...overrides,
  };
}

/** A class booking - the other shape the same endpoint returns. */
function classBooking(overrides: Record<string, unknown> = {}): unknown {
  return appointment({
    k_appointment: null,
    k_class: '268302',
    k_class_period: '18448467',
    k_service: null,
    s_title: 'A Joyful Noise | 60 Minutes',
    dt_date_global: '2026-08-19 15:00:00',
    dt_date_local: '2026-08-19 11:00:00',
    dt_cancel: '2026-08-18 15:00:00',
    a_staff: [{ k_staff: '868220', s_name_full: 'Robert Sewall' }],
    ...overrides,
  });
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'cs.1', kLog: null, httpStatus: 200, latencyMs: 40 };
}

describe('parseVisitList', () => {
  it('reads the pointers, which are all the list carries', () => {
    expect(parseVisitList({ a_visit: [{ k_visit: 1, dtu_date: 'x' }, { k_visit: '2' }] })).toEqual([
      '1',
      '2',
    ]);
  });

  // A client with nothing booked is a real answer, not a failure.
  it('returns nothing for a client with no upcoming visits', () => {
    expect(parseVisitList({ a_visit: [] })).toEqual([]);
    expect(parseVisitList({})).toEqual([]);
  });
});

describe('parseVisitElement', () => {
  it('keys an APPOINTMENT on its own appointment key', () => {
    const p = parseVisitElement(appointment(), K_BUSINESS);
    expect(p?.session).toMatchObject({
      k_period: '132190448',
      session_kind: 'appointment',
      k_appointment: '132190448',
      k_class: null,
      k_service: '142544',
      dt_start_utc: '2026-08-25 17:00:00',
    });
  });

  it('keys a CLASS BOOKING on the class period, so it lands on the schedule row', () => {
    const p = parseVisitElement(classBooking(), K_BUSINESS);
    expect(p?.session).toMatchObject({
      k_period: '18448467',
      session_kind: 'class',
      k_class: '268302',
      k_appointment: null,
      dt_start_utc: '2026-08-19 15:00:00',
    });
  });

  // The whole reason this pass exists: the class schedule names one teacher; the
  // other sixteen only appear here.
  it('carries the staff who deliver the session', () => {
    expect(parseVisitElement(appointment(), K_BUSINESS)?.staff).toEqual([
      { k_staff: '344486', s_name: 'Jared Feldman' },
    ]);
  });

  // Measured 40 of 40 visits: exactly 24h before start, attended ones included.
  // A column called "cancelled at" holding this would be wrong on every row.
  it('stores dt_cancel as a DEADLINE, never as a cancellation', () => {
    const p = parseVisitElement(appointment(), K_BUSINESS);
    expect(p?.session.dt_cancel_by).toBe('2026-08-24 17:00:00');
    expect(p?.session).not.toHaveProperty('dt_cancelled_studio_utc');
  });

  it('reads the check-in flag, which is the only outcome WL reports here', () => {
    expect(parseVisitElement(appointment(), K_BUSINESS)?.session.is_checkin).toBe(false);
    expect(
      parseVisitElement(appointment({ is_checkin: true }), K_BUSINESS)?.session.is_checkin,
    ).toBe(true);
  });

  it('prefers the appointment key when WL somehow sends both', () => {
    const p = parseVisitElement(
      appointment({ k_class_period: '18448467', k_class: '268302' }),
      K_BUSINESS,
    );
    expect(p?.session.session_kind).toBe('appointment');
    expect(p?.session.k_period).toBe('132190448');
  });

  // PRD 7.5. WL nests these under a_appointment_visit_info, not at the top level -
  // reading them from the root would silently give false for every session.
  it('reads the booking-request state from where WL actually nests it', () => {
    const p = parseVisitElement(
      appointment({
        a_appointment_visit_info: { is_request: true, is_confirmed: false, is_deny: false },
      }),
      K_BUSINESS,
    );
    expect(p?.session).toMatchObject({
      is_request: true,
      is_confirmed: false,
      is_denied: false,
    });
  });

  it('maps is_deny onto is_denied', () => {
    const p = parseVisitElement(
      appointment({ a_appointment_visit_info: { is_deny: true } }),
      K_BUSINESS,
    );
    expect(p?.session.is_denied).toBe(true);
  });

  // The trap 0021 exists around: is_confirmed is false on every live payload.
  // If it were treated as "not confirmed" the whole business would be excluded,
  // so the parser must record it faithfully and leave the judgement to the view.
  it('records is_confirmed as false WITHOUT that meaning anything is wrong', () => {
    const p = parseVisitElement(appointment(), K_BUSINESS);
    expect(p?.session.is_confirmed).toBe(false);
    expect(p?.session.is_request).toBe(false);
    expect(p?.session.is_denied).toBe(false);
  });

  it('defaults all three to false when WL omits the block entirely', () => {
    const p = parseVisitElement(appointment({ a_appointment_visit_info: undefined }), K_BUSINESS);
    expect(p?.session).toMatchObject({
      is_request: false,
      is_confirmed: false,
      is_denied: false,
    });
  });

  it('refuses a visit with neither key, because the key IS its identity', () => {
    expect(
      parseVisitElement(appointment({ k_appointment: null, k_class_period: null }), K_BUSINESS),
    ).toBeNull();
  });

  it('refuses a visit with no start time', () => {
    expect(parseVisitElement(appointment({ dt_date_global: '' }), K_BUSINESS)).toBeNull();
  });
});

describe('writeClientSession', () => {
  function fakeDb() {
    const calls: Array<{
      op: string;
      table: string;
      rows?: unknown[];
      options?: { onConflict?: string } | undefined;
    }> = [];
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-cs' }] : rows);
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

  const input = (body: unknown) => ({
    kBusiness: K_BUSINESS,
    uid: UID,
    kVisit: K_VISIT,
    response: response(body),
    runId: 'run-1',
  });

  it('upserts the session on its key and start, so re-running refreshes', async () => {
    const { db, calls } = fakeDb();
    await writeClientSession(db, input(appointment()));

    const upsert = calls.find((c) => c.op === 'upsert' && c.table === 'session');
    expect(upsert?.options?.onConflict).toBe('k_period,dt_start_utc');
  });

  it('writes location and service stubs BEFORE the session that references them', async () => {
    const { db, calls } = fakeDb();
    await writeClientSession(db, input(appointment()));

    const order = calls.filter((c) => c.op === 'upsert').map((c) => c.table);
    expect(order.indexOf('location')).toBeLessThan(order.indexOf('session'));
    expect(order.indexOf('service')).toBeLessThan(order.indexOf('session'));
  });

  // An appointment has exactly one attendee: the client whose list produced it.
  // Without this the session exists with nobody attached to it.
  it('attaches the client whose list produced the visit as its attendee', async () => {
    const { db, calls } = fakeDb();
    await writeClientSession(db, input(appointment()));

    const att = calls.find((c) => c.table === 'attendance');
    expect(att?.rows?.[0]).toMatchObject({
      uid: UID,
      k_visit: K_VISIT,
      k_period: '132190448',
    });
  });

  /**
   * This test used to pass `is_checkin: true` and assert `is_attended: true`,
   * pinning the misread migration 0029 fixes: is_checkin means "ready to be
   * checked in", not "attended". The fixture's own id_visit is 1 (BOOK) - a
   * reservation that has not happened - so the honest answer is "not known".
   */
  it('does not claim attendance from a booking that has not happened', async () => {
    const { db, calls } = fakeDb();
    await writeClientSession(db, input(appointment({ is_checkin: true })));

    const att = calls.find((c) => c.table === 'attendance');
    expect(att?.rows?.[0]).toMatchObject({ id_visit: '1', is_attended: null });
  });

  // The nested position is the one WL actually fills - the docs put id_visit at
  // the top level and it was null there on every measured payload.
  it('reads the visit status from where WL actually puts it, and counts ATTEND', async () => {
    const { db, calls } = fakeDb();
    await writeClientSession(
      db,
      input(
        appointment({
          a_appointment_visit_info: {
            id_visit: 3,
            is_request: false,
            is_confirmed: false,
            is_deny: false,
          },
        }),
      ),
    );

    const att = calls.find((c) => c.table === 'attendance');
    expect(att?.rows?.[0]).toMatchObject({
      id_visit: '3',
      is_attended: true,
      is_cancelled_client: false,
    });
  });

  it('records a late cancellation as both cancelled and late', async () => {
    const { db, calls } = fakeDb();
    await writeClientSession(db, input(appointment({ a_appointment_visit_info: { id_visit: 4 } })));

    const att = calls.find((c) => c.table === 'attendance');
    expect(att?.rows?.[0]).toMatchObject({
      id_visit: '4',
      is_attended: false,
      is_cancelled_client: true,
      is_late_cancel: true,
    });
  });

  it('records the staff against the occurrence', async () => {
    const { db, calls } = fakeDb();
    const result = await writeClientSession(db, input(appointment()));

    expect(result).toMatchObject({ written: true, kind: 'appointment', staffCount: 1 });
    const staff = calls.find((c) => c.table === 'session_staff');
    expect(staff?.rows?.[0]).toMatchObject({ k_staff: '344486', k_period: '132190448' });
  });

  // PRD 7.3. The counter is the caller's knowledge - the writer sees one payload
  // and cannot know how many times it has been read.
  it('records the fetch count and time when the caller supplies them', async () => {
    const { db, calls } = fakeDb();
    await writeClientSession(db, {
      ...input(appointment()),
      detailFetchCount: 2,
      fetchedAt: '2026-08-25T09:00:00.000Z',
    });

    const sess = calls.find((c) => c.op === 'upsert' && c.table === 'session');
    expect(sess?.rows?.[0]).toMatchObject({
      detail_fetch_count: 2,
      detail_fetched_at: '2026-08-25T09:00:00.000Z',
    });
  });

  // Omitting it must LEAVE the stored count alone, not reset it to zero - a
  // PostgREST upsert writes only the columns it is sent.
  it('leaves the stored fetch count untouched when not supplied', async () => {
    const { db, calls } = fakeDb();
    await writeClientSession(db, input(appointment()));

    const sess = calls.find((c) => c.op === 'upsert' && c.table === 'session');
    expect(sess?.rows?.[0]).not.toHaveProperty('detail_fetch_count');
    expect(sess?.rows?.[0]).not.toHaveProperty('detail_fetched_at');
  });

  it('stores the payload but writes nothing when the visit cannot be keyed', async () => {
    const { db, calls } = fakeDb();
    const result = await writeClientSession(
      db,
      input(appointment({ k_appointment: null, k_class_period: null })),
    );

    expect(result.written).toBe(false);
    expect(calls.some((c) => c.table === 'raw_wl')).toBe(true);
    expect(calls.some((c) => c.op === 'upsert')).toBe(false);
  });
});

describe('the session upsert carries only session columns', () => {
  /**
   * THE BUG THIS PINS. `id_visit` is WL's verdict on one client's visit, so
   * migration 0029 put it on `attendance`. It rides on the parsed session only
   * because the visit payload is where it arrives. Spreading the parsed session
   * straight into the `session` upsert therefore sent a column that does not
   * exist there, and PostgREST answered
   *
   *   PGRST204: Could not find the 'id_visit' column of 'session'
   *
   * on EVERY visit. That failed the item, failed the pass, and from the outside
   * looked like an ordinary partial run - so `session` sat frozen at 4,423 rows
   * for days while raw_wl kept filling up with payloads nobody could store.
   */
  function spy() {
    const calls: Array<{ table: string; rows: unknown[] }> = [];
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) =>
        Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-1' }] : rows),
      ),
      upsert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ table, rows });
        return Promise.resolve(rows);
      }),
      update: vi.fn(() => Promise.resolve([])),
      select: vi.fn(() => Promise.resolve([])),
    };
    return { db: db as unknown as SupabaseClient, calls };
  }

  const write = async (body: unknown) => {
    const { db, calls } = spy();
    await writeClientSession(db, {
      kBusiness: K_BUSINESS,
      uid: UID,
      kVisit: K_VISIT,
      response: response(body),
      runId: 'run-1',
    });
    return calls;
  };

  it('never sends id_visit to the session table', async () => {
    const calls = await write(appointment());
    const sessionRows = calls.filter((c) => c.table === 'session').flatMap((c) => c.rows);
    expect(sessionRows.length).toBeGreaterThan(0);
    for (const row of sessionRows) {
      expect(Object.keys(row as Record<string, unknown>)).not.toContain('id_visit');
    }
  });

  it('still sends it to attendance, which is where it belongs', async () => {
    const calls = await write(appointment());
    const attendanceRows = calls.filter((c) => c.table === 'attendance').flatMap((c) => c.rows);
    expect(attendanceRows.length).toBeGreaterThan(0);
    for (const row of attendanceRows) {
      expect(Object.keys(row as Record<string, unknown>)).toContain('id_visit');
    }
  });
});
