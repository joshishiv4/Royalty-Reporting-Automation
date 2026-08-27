import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runAttendanceSyncPass } from '../src/sync/pass.js';

/**
 * `/v1/login/attendance/list` covers BOTH classes and appointments, and the key
 * goes in the parameter that matches its kind.
 *
 * THIS FILE USED TO ASSERT THE OPPOSITE, and the story is worth keeping because
 * the evidence was real and the conclusion drawn from it was not.
 *
 * WL answers 200 with sid `id-nx` - "The ID value for k_class_period that you
 * have specified does not exist" - for an appointment key. Measured on live dev:
 * 681 dead attendance rows out of 1,018, every one for an appointment. That was
 * read as "the endpoint is class-only", and this test enforced it.
 *
 * WL's own spec says otherwise. The endpoint is summarised as "clients attending
 * a class, APPOINTMENT, or event session" and documents two mutually exclusive
 * parameters:
 *
 *   k_class_period - "not used if requesting information for an appointment"
 *   k_appointment  - "not used if requesting information for a class or event"
 *
 * An appointment session stores its k_appointment as `k_period` (see
 * client-sessions.ts), and we only ever sent it AS k_class_period. So `id-nx` was
 * a correct answer to a question asked wrongly - the same shape of mistake as
 * `dt_date` versus `dt_date_local`, which had this endpoint recorded as blocked
 * for days.
 *
 * Probed live 27 Aug 2026 on one past and one upcoming appointment: k_appointment=
 * is accepted and returns the attendee carrying id_visit (3 ATTEND on the past
 * one, 1 BOOK on the upcoming one), while the same key as k_class_period still
 * fails with id-nx.
 *
 * Why it matters: 4,412 of 4,423 sessions are appointments, and their only outcome
 * source was page/element, which is read while a visit is still upcoming and so
 * records BOOK indefinitely.
 */

const K_BUSINESS = '111111';
const config = {
  env: 'dev',
  wl: { kBusiness: K_BUSINESS, clientId: '', clientSecret: '', host: '', authHost: '', region: 0 },
} as unknown as AppConfig;

/** A harness that runs the pass over exactly one queued session. */
function harness(session: { k_period: string; dt_start_utc: string; session_kind: string }) {
  const requested: Array<{ path: string; query: Record<string, unknown> }> = [];
  const wl = {
    runId: 'run-x',
    request: vi.fn((path: string, options: { query?: Record<string, unknown> } = {}) => {
      requested.push({ path, query: options.query ?? {} });
      return Promise.resolve({
        body: { a_list_active: [], a_list_confirm: [], a_list_wait: [], status: 'ok' },
        traceId: 't',
        kLog: null,
        httpStatus: 200,
        latencyMs: 1,
      });
    }),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;

  const queries: string[] = [];
  let claimed = false;
  const item = {
    id: 'q1',
    work_type: 'session_attendance',
    target_key: `${session.k_period}|${session.dt_start_utc}`,
    k_business: K_BUSINESS,
    attempt_count: 0,
  };

  const db = {
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : [{ id: 'raw-1' }, ...rows]),
    ),
    update: vi.fn((table: string, _patch: unknown, query: string) => {
      // The claim is a compare-and-swap that returns the row it won.
      if (table === 'sync_queue' && query.includes('state=eq.pending') && !claimed) {
        claimed = true;
        return Promise.resolve([item]);
      }
      return Promise.resolve([]);
    }),
    upsert: vi.fn((_t: string, rows: unknown[]) => Promise.resolve(rows)),
    select: vi.fn((table: string, query: string) => {
      queries.push(`${table}?${query}`);
      if (table === 'sync_queue' && query.includes('order=next_attempt_at.asc') && !claimed) {
        return Promise.resolve([item]);
      }
      // The handler reads the local start time and the kind back off the session.
      if (table === 'session' && query.includes('select=dtl_start_local,session_kind')) {
        return Promise.resolve([
          { dtl_start_local: '2026-08-26T20:30:00', session_kind: session.session_kind },
        ]);
      }
      return Promise.resolve([]);
    }),
    // selectAll pages in production (PostgREST caps a read at 1,000 rows);
    // a fake answers in one call, so it shares the select handler.
    selectAll(table: string, query: string) {
      // `this` is cast because several of these literals are inferred as {}
      // before the outer `as unknown as SupabaseClient` is applied.
      return (this as { select: (t: string, q: string) => Promise<unknown[]> }).select(
        table,
        query,
      );
    },
  } as unknown as SupabaseClient;

  return { wl, db, queries, requested };
}

describe('runAttendanceSyncPass seed', () => {
  it('does NOT exclude appointments any more', async () => {
    const h = harness({ k_period: '18448467', dt_start_utc: 'x', session_kind: 'class' });
    await runAttendanceSyncPass(config, { wl: h.wl, db: h.db, now: () => 0 });

    const sessionSelect = h.queries.find(
      (q) => q.startsWith('session?') && q.includes(`k_business=eq.${K_BUSINESS}`),
    );
    expect(sessionSelect).toBeDefined();
    // The filter that hid 4,412 of 4,423 sessions from this pass.
    expect(sessionSelect).not.toContain('session_kind=eq.class');
  });
});

describe('the key goes in the parameter that matches its kind', () => {
  it('sends k_appointment for an appointment', async () => {
    const h = harness({
      k_period: '126304720',
      dt_start_utc: '2026-08-27T00:30:00.000Z',
      session_kind: 'appointment',
    });
    await runAttendanceSyncPass(config, { wl: h.wl, db: h.db, now: () => 0 });

    const call = h.requested.find((r) => r.path.includes('attendance/list'));
    expect(call).toBeDefined();
    expect(call?.query.k_appointment).toBe('126304720');
    // Sending it as a class period is exactly what produced 681 dead rows.
    expect(call?.query.k_class_period).toBeUndefined();
  });

  it('sends k_class_period for a class', async () => {
    const h = harness({
      k_period: '18448467',
      dt_start_utc: '2026-08-19T15:00:00.000Z',
      session_kind: 'class',
    });
    await runAttendanceSyncPass(config, { wl: h.wl, db: h.db, now: () => 0 });

    const call = h.requested.find((r) => r.path.includes('attendance/list'));
    expect(call?.query.k_class_period).toBe('18448467');
    expect(call?.query.k_appointment).toBeUndefined();
  });

  it('still sends the LOCAL start time, which is what unblocked this endpoint', async () => {
    const h = harness({
      k_period: '126304720',
      dt_start_utc: '2026-08-27T00:30:00.000Z',
      session_kind: 'appointment',
    });
    await runAttendanceSyncPass(config, { wl: h.wl, db: h.db, now: () => 0 });

    const call = h.requested.find((r) => r.path.includes('attendance/list'));
    // Space-separated, no T, no timezone - WL rejects anything else.
    expect(call?.query.dt_date_local).toBe('2026-08-26 20:30:00');
  });
});
