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

const config = {
  env: 'dev',
  wl: { kBusiness: K_BUSINESS },
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
  runtime: { maxConcurrency: 5, httpTimeoutMs: 30000 },
} as unknown as AppConfig;

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
  const calls: Array<{ path: string; query: Record<string, unknown> }> = [];
  const wl = {
    runId: 'run-x',
    request: vi.fn((path: string, opts?: { query?: Record<string, unknown> }) => {
      requested.push(path);
      calls.push({ path, query: opts?.query ?? {} });
      if (path.endsWith('/page/list')) {
        return Promise.resolve({
          body: { a_visit: visits.map((v) => ({ k_visit: v.kVisit })) },
          traceId: 't',
          kLog: null,
          httpStatus: 200,
          latencyMs: 1,
        });
      }
      const raw = opts?.query?.['k_visit'];
      const kVisit = typeof raw === 'string' ? raw : '';
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
    // enqueue writes through a Postgres function now (migration 0032), so a
    // fake db has to answer it. It reports everything as inserted: these
    // tests are about what gets queued, not how Postgres resolves a clash.
    rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
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
    calls,
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

  it('costs only its list calls for a client whose sessions have all settled', async () => {
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
    // The point of the 7.3 rule: a settled client costs NO detail calls at all.
    expect(h.detailCalls()).toBe(0);
    // Two list calls, not one, and that is the cost of having history: `{ uid }`
    // answers with upcoming visits only, and `is_past=1` is a separate mode -
    // neither call sees the other's half. Two cheap list calls per client is the
    // whole price of no longer starting the database at "now".
    expect(h.requested.filter((p) => p.endsWith('/page/list'))).toHaveLength(2);
  });
});

describe('history is asked for explicitly, and only history uses the window', () => {
  // Mutation-proofing: dropping is_past from the second call silently returns the
  // FUTURE list twice, so the pass would look healthy while fetching no history
  // at all. That is exactly the failure this project spent weeks not noticing.
  it('sends is_past on the second list call, with the window', async () => {
    const h = harness([{ kVisit: 'v1', start: FUTURE }], []);
    await run(h);

    const lists = h.calls.filter((c) => c.path.endsWith('/page/list'));
    expect(lists).toHaveLength(2);

    const past = lists.filter((c) => c.query.is_past !== undefined);
    expect(past).toHaveLength(1);
    expect(past[0]?.query.dtu_start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(past[0]?.query.dtu_end).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('does NOT send dates on the upcoming call', async () => {
    // Without is_past the endpoint ignores date parameters and answers the future
    // list regardless - sending them would only imply a filter that is not there.
    const h = harness([{ kVisit: 'v1', start: FUTURE }], []);
    await run(h);

    const upcoming = h.calls
      .filter((c) => c.path.endsWith('/page/list'))
      .find((c) => c.query.is_past === undefined);
    expect(upcoming).toBeDefined();
    expect(upcoming?.query.dtu_start).toBeUndefined();
    expect(Object.keys(upcoming?.query ?? {})).toEqual(['uid']);
  });

  it('reaches back to the configured floor when nothing has completed cleanly', async () => {
    const h = harness([{ kVisit: 'v1', start: FUTURE }], []);
    await run(h);

    const past = h.calls.find((c) => c.query.is_past !== undefined);
    expect(String(past?.query.dtu_start)).toContain('1980-01-01');
  });
});
