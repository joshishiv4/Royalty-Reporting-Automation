import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runAttendanceSyncPass } from '../src/sync/pass.js';

/**
 * The seed for attendance_sync MUST filter to session_kind = 'class'.
 *
 * `/v1/login/attendance/list` is a class-period lookup - documented that way in
 * both the Postman collection and apidoc.wellnessliving.io - and WL answers 200
 * with sid `id-nx` for anything that is not a k_class_period. An appointment
 * session in this project stores its k_appointment as `k_period` (see
 * client-sessions.ts:93), and passing that to this endpoint deterministically
 * dies with "The ID value for k_class_period that you have specified does not
 * exist". Live on dev: 681 dead attendance rows out of 1,018, every one of
 * them for a session whose kind was 'appointment'.
 *
 * Appointments do not need the attendance call: a private session has ONE
 * payer who is by definition the attendee, and client_session_sync already
 * writes them. This seed enforces the exclusion so no appointment target
 * reaches the queue in the first place.
 */

const config = {
  env: 'dev',
  wl: { kBusiness: '111111', clientId: '', clientSecret: '', host: '', authHost: '', region: 0 },
} as unknown as AppConfig;

function fakeWl(): WlClient {
  return {
    runId: 'run-x',
    request: vi.fn(() =>
      Promise.resolve({ body: {}, traceId: 't', kLog: null, httpStatus: 200, latencyMs: 1 }),
    ),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;
}

describe('runAttendanceSyncPass seed', () => {
  it('reads sessions with session_kind=eq.class and no other kind', async () => {
    const queries: string[] = [];
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) =>
        Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
      ),
      update: vi.fn(() => Promise.resolve([])),
      upsert: vi.fn((_t: string, rows: unknown[]) => Promise.resolve(rows)),
      select: vi.fn((table: string, query: string) => {
        queries.push(`${table}?${query}`);
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

    await runAttendanceSyncPass(config, { wl: fakeWl(), db, now: () => 0 });

    // The seed's select on the session table MUST include a session_kind=eq.class
    // filter. Anything else would let appointments slip through and every one
    // of them would come back as id-nx from WL.
    const sessionSelect = queries.find(
      (q) => q.startsWith('session?') && q.includes('k_business=eq.111111'),
    );
    expect(sessionSelect).toBeDefined();
    expect(sessionSelect).toContain('session_kind=eq.class');
    expect(sessionSelect).not.toContain('session_kind=eq.appointment');
  });
});
