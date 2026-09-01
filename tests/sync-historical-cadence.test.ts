import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runHistoricalScheduleSyncPass } from '../src/sync/pass.js';

/**
 * What the MONTHLY run seeds when nobody has asked it for anything.
 *
 * The pass used to exit when no window override was recorded, which made a
 * deliberate backfill easy and a routine re-check impossible. It now derives
 * its own range - the last SYNC_MONTHLY_LOOKBACK_MONTHS calendar months - and
 * widens the visit window to match, because appointments carry the same
 * retroactive-edit gap and their daily window is only three days.
 *
 * Four behaviours are load-bearing and each is asserted below:
 *
 *   1. no ask       -> the derived months are queued
 *   2. an ask       -> the ask is honoured EXACTLY, and the visit window is left
 *                      alone (backfilling schedules from 1980 must not re-list
 *                      every appointment ever recorded)
 *   3. 0 months     -> nothing is queued, the old behaviour restored by config
 *   4. visit window -> an override already sitting there is somebody else's ask
 *      already set      and is never overwritten
 */

const K_BUSINESS = '111111';

function config(monthlyLookbackMonths: number): AppConfig {
  return {
    env: 'dev',
    wl: {
      kBusiness: K_BUSINESS,
      clientId: '',
      clientSecret: '',
      host: '',
      authHost: '',
      region: 0,
    },
    sync: { historyStart: '1980-01-01', dailyLookbackDays: 3, monthlyLookbackMonths },
    runtime: { maxConcurrency: 5, httpTimeoutMs: 30000 },
  } as unknown as AppConfig;
}

function fakeWl(): WlClient {
  return {
    runId: 'run-x',
    request: vi.fn(() =>
      Promise.resolve({ body: {}, traceId: 'run-x.1', kLog: null, httpStatus: 200, latencyMs: 1 }),
    ),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;
}

interface WindowRow {
  last_clean_completion_at: string | null;
  window_start_override: string | null;
  window_end_override: string | null;
}

const noWindow: WindowRow = {
  last_clean_completion_at: '2026-09-30T03:00:00.000Z',
  window_start_override: null,
  window_end_override: null,
};

function fakeDb(windows: Record<string, WindowRow>) {
  /** Every target_key handed to enqueue, in order. */
  const queued: string[] = [];
  /** Every sync_job_state upsert, so a window write can be identified. */
  const stateWrites: Array<Record<string, unknown>> = [];

  const db = {
    rpc: vi.fn((_fn: string, args: { items: Array<{ target_key: string }> }) => {
      for (const item of args.items) queued.push(item.target_key);
      return Promise.resolve(args.items.length);
    }),
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
    ),
    // The claim CAS finds nothing, so the pass drains immediately after seeding.
    // The job lock is also a conditional UPDATE (0035): answering [] for it would
    // make the pass stand down as already-running and seed nothing at all.
    update: vi.fn((table: string) =>
      Promise.resolve(table === 'sync_job_state' ? [{ job_name: 'j' }] : []),
    ),
    upsert: vi.fn((table: string, rows: Array<Record<string, unknown>>) => {
      if (table === 'sync_job_state') stateWrites.push(...rows);
      return Promise.resolve(rows);
    }),
    select: vi.fn((table: string, query: string) => {
      if (table === 'person') return Promise.resolve([{ uid: 'u1' }]);
      if (table === 'sync_job_state') {
        for (const [job, row] of Object.entries(windows)) {
          if (query.includes(`job_name=eq.${job}&`)) return Promise.resolve([row]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
    selectAll(table: string, query: string) {
      return (this as { select: (t: string, q: string) => Promise<unknown[]> }).select(
        table,
        query,
      );
    },
  };

  return { db: db as unknown as SupabaseClient, queued, stateWrites };
}

/** The window write aimed at the daily visit pass, if the run made one. */
function visitWindowWrite(stateWrites: Array<Record<string, unknown>>) {
  return stateWrites.find((r) => r['job_name'] === 'client_session_sync');
}

/** 1 October 2026, 04:00 UTC - the monthly cron's real firing shape. */
const FIRED_AT = Date.parse('2026-10-01T04:00:00.000Z');

describe('the monthly run with nothing asked of it', () => {
  it('queues the last two calendar months, so September is re-read in full', async () => {
    const { db, queued } = fakeDb({
      historical_schedule_sync: noWindow,
      client_session_sync: noWindow,
    });

    await runHistoricalScheduleSyncPass(config(2), { wl: fakeWl(), db, now: () => FIRED_AT });

    // Firing on the 1st: the whole of September, plus the first day of October.
    expect(queued).toEqual(['u1|2026-09', 'u1|2026-10']);
  });

  it('widens the visit window to the same range, because appointments share the gap', async () => {
    const { db, stateWrites } = fakeDb({
      historical_schedule_sync: noWindow,
      client_session_sync: noWindow,
    });

    await runHistoricalScheduleSyncPass(config(2), { wl: fakeWl(), db, now: () => FIRED_AT });

    // A start with no end means "from there to now" - see visit-window.ts.
    expect(visitWindowWrite(stateWrites)).toMatchObject({
      job_name: 'client_session_sync',
      window_start_override: '2026-09-01 00:00:00',
      window_end_override: null,
    });
  });

  it('queues nothing at all when the cadence is switched off with 0', async () => {
    const { db, queued, stateWrites } = fakeDb({
      historical_schedule_sync: noWindow,
      client_session_sync: noWindow,
    });

    await runHistoricalScheduleSyncPass(config(0), { wl: fakeWl(), db, now: () => FIRED_AT });

    expect(queued).toEqual([]);
    expect(visitWindowWrite(stateWrites)).toBeUndefined();
  });

  it('leaves a visit window somebody else already set exactly as it was', async () => {
    const { db, stateWrites } = fakeDb({
      historical_schedule_sync: noWindow,
      client_session_sync: {
        last_clean_completion_at: null,
        window_start_override: '2020-01-01 00:00:00',
        window_end_override: null,
      },
    });

    await runHistoricalScheduleSyncPass(config(2), { wl: fakeWl(), db, now: () => FIRED_AT });

    expect(visitWindowWrite(stateWrites)).toBeUndefined();
  });
});

describe('the monthly run with an explicit request pending', () => {
  const asked: WindowRow = {
    last_clean_completion_at: null,
    window_start_override: '2025-01-01',
    window_end_override: '2025-03-15',
  };

  it('honours the requested range exactly, ignoring the cadence', async () => {
    const { db, queued } = fakeDb({
      historical_schedule_sync: asked,
      client_session_sync: noWindow,
    });

    await runHistoricalScheduleSyncPass(config(2), { wl: fakeWl(), db, now: () => FIRED_AT });

    expect(queued).toEqual(['u1|2025-01', 'u1|2025-02', 'u1|2025-03']);
  });

  it('does NOT widen the visit window off the back of a schedule request', async () => {
    const { db, stateWrites } = fakeDb({
      historical_schedule_sync: asked,
      client_session_sync: noWindow,
    });

    await runHistoricalScheduleSyncPass(config(2), { wl: fakeWl(), db, now: () => FIRED_AT });

    // Asking for three months of SCHEDULE must not re-list every appointment
    // in that range as a side effect the caller never requested.
    expect(visitWindowWrite(stateWrites)).toBeUndefined();
  });
});
