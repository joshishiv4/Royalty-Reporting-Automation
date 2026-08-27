import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runClientSessionSyncPass } from '../src/sync/pass.js';

/**
 * The at-most-twice rule (PRD 7.3), tested at the pass level because that is
 * where it lives - the writer sees one payload and cannot know how often it has
 * been read.
 *
 * The rule the ticket actually asks for is not "no more than two reads". It is
 * "once when it is discovered, and once AFTER ITS DATE HAS PASSED". Those differ:
 * a second read spent while the session is still upcoming burns the quota on an
 * outcome that has not happened yet, and the real one is then never read at all.
 * The first implementation here got that wrong and it took a live run to see it -
 * hence these tests.
 */

const K_BUSINESS = '111111';
const UID = '36453792';
const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const PAST = '2026-08-20 15:00:00'; // five days before NOW
const FUTURE = '2026-09-20 15:00:00'; // well after NOW
const ANCIENT = '2026-08-01 15:00:00'; // more than a week before NOW

const config = { env: 'dev', wl: { kBusiness: K_BUSINESS } } as unknown as AppConfig;

function visitBody(kVisit: string, dtGlobal: string): unknown {
  return {
    k_appointment: `appt-${kVisit}`,
    k_class_period: null,
    k_service: 'svc-1',
    k_location: 'loc-1',
    dt_date_global: dtGlobal,
    dt_date_local: dtGlobal,
    text_timezone: 'ET',
    s_title: 'Private lesson',
    is_checkin: false,
    a_staff: [],
  };
}

/**
 * @param known what the database already holds for these visits
 * @returns the WL paths requested, so we can count DETAIL calls
 */
function harness(
  visits: Array<{ kVisit: string; start: string }>,
  known: Array<{ kVisit: string; count: number; start: string }>,
) {
  const requested: string[] = [];
  const wl = {
    runId: 'run-x',
    request: vi.fn((path: string, opts?: { query?: Record<string, string> }) => {
      requested.push(path);
      if (path.endsWith('/page/list')) {
        return Promise.resolve({
          body: { a_visit: visits.map((v) => ({ k_visit: v.kVisit })) },
          traceId: 't',
          kLog: null,
          httpStatus: 200,
          latencyMs: 1,
        });
      }
      const kVisit = opts?.query?.['k_visit'] ?? '';
      const found = visits.find((v) => v.kVisit === kVisit);
      return Promise.resolve({
        body: visitBody(kVisit, found?.start ?? FUTURE),
        traceId: 't',
        kLog: null,
        httpStatus: 200,
        latencyMs: 1,
      });
    }),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;

  let claimed = false;
  const db = {
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
    ),
    upsert: vi.fn((_t: string, rows: unknown[]) => Promise.resolve(rows)),
    update: vi.fn((_t: string, _patch: unknown, query: string) => {
      // The claim CAS: hand out the one queue item exactly once.
      if (query.includes('id=eq.') && query.includes('select=') && !claimed) {
        claimed = true;
        return Promise.resolve([
          {
            id: 'q1',
            work_type: 'client_visits',
            target_key: UID,
            k_business: K_BUSINESS,
            attempt_count: 0,
          },
        ]);
      }
      return Promise.resolve([]);
    }),
    select: vi.fn((table: string, query: string) => {
      if (table === 'sync_queue' && query.includes('order=next_attempt_at.asc') && !claimed) {
        return Promise.resolve([
          {
            id: 'q1',
            work_type: 'client_visits',
            target_key: UID,
            k_business: K_BUSINESS,
            attempt_count: 0,
          },
        ]);
      }
      // What the pass already knows about this client's visits.
      if (table === 'attendance') {
        return Promise.resolve(
          known.map((k) => ({
            k_visit: k.kVisit,
            session: { detail_fetch_count: k.count, dt_start_utc: k.start },
          })),
        );
      }
      if (table === 'person') return Promise.resolve([{ uid: UID }]);
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

  return {
    wl,
    db,
    requested,
    detailCalls: () => requested.filter((p) => p.endsWith('/element')).length,
  };
}

const run = (h: ReturnType<typeof harness>) =>
  runClientSessionSyncPass(config, { wl: h.wl, db: h.db, now: () => NOW, budgetMs: 60_000 });

describe('client session pass: the at-most-twice rule (PRD 7.3)', () => {
  it('reads a visit it has never seen', async () => {
    const h = harness([{ kVisit: 'v1', start: FUTURE }], []);
    await run(h);
    expect(h.detailCalls()).toBe(1);
  });

  // The bug the first implementation had, and the reason this file exists. A
  // second read here is spent on an is_checkin that is necessarily still false,
  // and the real outcome is then never read.
  it('does NOT spend the second read while the session is still upcoming', async () => {
    const h = harness(
      [{ kVisit: 'v1', start: FUTURE }],
      [{ kVisit: 'v1', count: 1, start: FUTURE }],
    );
    await run(h);
    expect(h.detailCalls()).toBe(0);
  });

  it('DOES take the second read once the session has happened', async () => {
    const h = harness([{ kVisit: 'v1', start: PAST }], [{ kVisit: 'v1', count: 1, start: PAST }]);
    await run(h);
    expect(h.detailCalls()).toBe(1);
  });

  it('never reads a third time', async () => {
    const h = harness([{ kVisit: 'v1', start: PAST }], [{ kVisit: 'v1', count: 2, start: PAST }]);
    await run(h);
    expect(h.detailCalls()).toBe(0);
  });

  // Without this, a visit that somehow never reached two reads is retried
  // forever and the daily run creeps back toward re-reading all of history.
  it('never re-reads a session more than a week past its start, whatever the count', async () => {
    const h = harness(
      [{ kVisit: 'v1', start: ANCIENT }],
      [{ kVisit: 'v1', count: 0, start: ANCIENT }],
    );
    await run(h);
    expect(h.detailCalls()).toBe(0);
  });

  it('costs a single list call for a client whose sessions have all settled', async () => {
    const h = harness(
      [
        { kVisit: 'v1', start: FUTURE },
        { kVisit: 'v2', start: FUTURE },
        { kVisit: 'v3', start: PAST },
      ],
      [
        { kVisit: 'v1', count: 1, start: FUTURE },
        { kVisit: 'v2', count: 1, start: FUTURE },
        { kVisit: 'v3', count: 2, start: PAST },
      ],
    );
    await run(h);
    expect(h.detailCalls()).toBe(0);
    expect(h.requested.filter((p) => p.endsWith('/page/list'))).toHaveLength(1);
  });
});
