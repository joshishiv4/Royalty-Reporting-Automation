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
    await writeClientSession(db, input(appointment({ is_checkin: true })));

    const att = calls.find((c) => c.table === 'attendance');
    expect(att?.rows?.[0]).toMatchObject({
      uid: UID,
      k_visit: K_VISIT,
      is_attended: true,
      k_period: '132190448',
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
