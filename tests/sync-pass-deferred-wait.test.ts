import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runClientListSyncPass } from '../src/sync/pass.js';

/**
 * A report pass finishes in ONE run, by waiting for its own deferred item.
 *
 * It used to end the moment nothing was claimable, which for a report pass is the
 * moment after it asks WL for a build. Each scheduled run therefore did one step,
 * and with Actions running the sync every 4-8 hours the 3-hour report handle had
 * always expired by the next one - so the step was "request" again, every run.
 * `tx_payment_sync` and `tx_item_sync` read no rows from 2 Oct to 8 Oct 2026, all
 * runs `partial`, nothing failed (STATUS.md).
 *
 * These drive the whole pass - queue, claim, defer, sleep, poll, write - against an
 * in-memory sync_queue and a fake clock that only moves when the pass sleeps.
 */

const K = '334942';
const T0 = Date.parse('2026-10-08T06:00:00.000Z');

const config = {
  env: 'dev',
  wl: { kBusiness: K },
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
  runtime: { maxConcurrency: 5, httpTimeoutMs: 30000 },
} as unknown as AppConfig;

// Every field the client-list writer maps; it refuses a page missing one.
const FIELDS = [
  'uid',
  'k_login_type',
  'field-general-2.text_name',
  'field-general-1',
  'field-general-3',
  'field-general-4',
  'field-general-5',
  'field-general-6',
  'field-general-7.dl_date',
  'field-general-11',
  'text_client_type',
];
const ROW = [
  '33793232',
  '1260510',
  'Jared',
  'Feldman',
  'jared@spindjacademy.com',
  '+15162720782',
  '',
  '',
  '1985-04-11',
  'MEM-4471',
  'Staff Client Profile',
];

interface QueueRow {
  id: string;
  work_type: string;
  target_key: string;
  k_business: string;
  state: string;
  attempt_count: number;
  next_attempt_at: string;
  [k: string]: unknown;
}

/**
 * `buildMs`: how long after the pass starts WL reports the build finished.
 * The clock moves only through `sleep`, so a pass that never sleeps never sees
 * the build finish - which is exactly the old behaviour being guarded against.
 */
function harness(buildMs: number) {
  let t = T0;
  const sleeps: number[] = [];
  const queue: QueueRow[] = [];
  let jobState: Record<string, unknown> = {};
  const runCloses: Array<Record<string, unknown>> = [];
  const personWrites: unknown[] = [];

  const built = () => t - T0 >= buildMs;
  const wl = {
    runId: 'run-1',
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
    request: vi.fn(() =>
      Promise.resolve({
        body: {
          a_field: FIELDS,
          a_row: [ROW],
          id_report_status: built() ? 3 : 2,
          dtu_complete: built() ? '2026-10-08 06:00:00' : null,
        },
        traceId: 't',
        kLog: null,
        httpStatus: 200,
        latencyMs: 1,
      }),
    ),
  } as unknown as WlClient;

  const param = (q: string, prefix: string) => new RegExp(`${prefix}([^&]+)`).exec(q)?.[1];

  const db = {
    rpc: vi.fn(
      (
        _fn: string,
        args: { items: Array<Pick<QueueRow, 'work_type' | 'target_key' | 'k_business'>> },
      ) => {
        for (const i of args.items) {
          queue.push({
            ...i,
            id: `q${String(queue.length + 1)}`,
            state: 'pending',
            attempt_count: 0,
            next_attempt_at: new Date(t).toISOString(),
          });
        }
        return Promise.resolve(args.items.length);
      },
    ),
    select: vi.fn((table: string, query: string) => {
      if (table === 'sync_job_state') {
        return Promise.resolve(jobState.report_handle !== undefined ? [jobState] : []);
      }
      if (table !== 'sync_queue' || !query.includes('state=eq.pending')) {
        return Promise.resolve([]);
      }
      const dueBy = param(query, 'next_attempt_at=lte.');
      const rows = queue
        .filter((r) => r.state === 'pending')
        .filter((r) => dueBy === undefined || r.next_attempt_at <= dueBy)
        .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at));
      return Promise.resolve(rows.map((r) => ({ ...r })));
    }),
    update: vi.fn((table: string, patch: Record<string, unknown>, query: string) => {
      if (table === 'sync_job_state') return Promise.resolve([{ job_name: 'client_list_sync' }]);
      if (table === 'sync_run') {
        if ('finished_at' in patch) runCloses.push(patch);
        return Promise.resolve([]);
      }
      if (table !== 'sync_queue') return Promise.resolve([]);
      const id = param(query, 'id=eq.');
      const row = queue.find((r) => r.id === id);
      if (row === undefined) return Promise.resolve([]); // reclaimExpired: nothing stuck
      if (query.includes('state=eq.pending') && row.state !== 'pending') {
        return Promise.resolve([]); // lost the claim race
      }
      Object.assign(row, patch);
      return Promise.resolve([{ ...row }]);
    }),
    upsert: vi.fn((table: string, rows: Array<Record<string, unknown>>) => {
      if (table === 'sync_job_state') jobState = { ...jobState, ...rows[0] };
      if (table === 'person') personWrites.push(...rows);
      return Promise.resolve(rows);
    }),
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-1' }] : rows),
    ),
    selectAll(table: string, query: string) {
      return (this as { select: (t: string, q: string) => Promise<unknown[]> }).select(
        table,
        query,
      );
    },
  } as unknown as SupabaseClient;

  const deps = {
    wl,
    db,
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
  return { deps, queue, sleeps, runCloses, personWrites, elapsed: () => t - T0 };
}

describe('a report pass waits for its own deferred build', () => {
  it('requests, polls and writes the report in ONE pass', async () => {
    const h = harness(20_000); // built 20 s in: needs the 5 s and 10 s rungs, then a poll
    const summary = await runClientListSyncPass(config, h.deps);

    // The whole state machine ran inside this one pass.
    expect(h.queue.map((r) => r.state)).toEqual(['done']);
    expect(h.personWrites).toHaveLength(1);
    expect(h.sleeps.length).toBeGreaterThan(0);
    // And because the deferral finished here, the run is not left 'partial' -
    // that would hold back the completion watermark for work that is done.
    expect(summary.state).toBe('ok');
    expect(h.runCloses.at(-1)).toMatchObject({ state: 'ok' });
  });

  it('stops waiting at the budget and says partial, leaving the item for the next run', async () => {
    const h = harness(60 * 60_000); // a build that does not finish inside the budget
    const summary = await runClientListSyncPass(config, { ...h.deps, budgetMs: 2 * 60_000 });

    expect(summary.state).toBe('partial');
    expect(h.queue.map((r) => r.state)).toEqual(['pending']);
    expect(h.personWrites).toHaveLength(0);
    // Never slept past its budget.
    expect(h.elapsed()).toBeLessThanOrEqual(2 * 60_000);
  });
});
