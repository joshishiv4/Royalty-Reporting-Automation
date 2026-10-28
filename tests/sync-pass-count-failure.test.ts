import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runClientListSyncPass, UNKNOWN_REMAINING } from '../src/sync/pass.js';

/**
 * A pass that did all its work still CLOSES ITS RUN when the final count fails.
 *
 * countEligible runs after the drain, outside the try/catch that records a
 * failure, and decides only what the run row says about what is left. On 9 Oct
 * 2026 a `57014: canceling statement due to statement timeout` there threw
 * straight out of runPass: closeRun never ran, so purchase_element_sync left a
 * row reading 'running' for the stale sweep to retire half an hour later, and a
 * pass that had drained all 399,140 purchase elements was logged 'failed' with
 * claimed/done/dead all zero - placeholders from the orchestrator's catch, not
 * measurements.
 *
 * The queue was at 100% and the drain had finished at 11:09:57, nine minutes
 * before the timeout. Nothing was wrong with the work. Only the number was.
 */

const K = '334942';
const T0 = Date.parse('2026-10-09T10:20:38.000Z');

const config = {
  env: 'dev',
  wl: { kBusiness: K },
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
  runtime: { maxConcurrency: 5, httpTimeoutMs: 30000 },
} as unknown as AppConfig;

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
  // Read by the client-list pass since 0064; a page without them is refused. A
  // null flag leaves the note alone, so these fixtures write and delete no note.
  'o_note.has_note',
  'o_note.text_note_list',
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
  null,
  null,
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

/** The shape SupabaseClient throws: a named error carrying the table. */
class FakeSupabaseError extends Error {
  readonly table: string;
  constructor(message: string, table: string) {
    super(message);
    this.name = 'SupabaseError';
    this.table = table;
  }
}

/**
 * `countFails`: the post-drain count throws, as a statement timeout does.
 * It is told apart from the claim read by its `limit=1000&select=id` - the claim
 * reads ITEM_COLUMNS, this one reads ids only to count them.
 */
function harness(countFails: boolean) {
  let t = T0;
  const queue: QueueRow[] = [];
  let jobState: Record<string, unknown> = {};
  const runCloses: Array<Record<string, unknown>> = [];
  const jobStateCloses: Array<Record<string, unknown>> = [];
  const personWrites: unknown[] = [];
  let counts = 0;

  const wl = {
    runId: 'run-1',
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
    request: vi.fn(() =>
      Promise.resolve({
        body: {
          a_field: FIELDS,
          a_row: [ROW],
          id_report_status: 3,
          dtu_complete: '2026-10-09 10:20:38',
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
      // countEligible: the post-drain count, not the claim.
      if (query.includes('limit=1000') && query.includes('select=id')) {
        counts += 1;
        if (countFails) {
          return Promise.reject(
            new FakeSupabaseError(
              '57014: canceling statement due to statement timeout',
              'sync_queue',
            ),
          );
        }
      }
      const dueBy = param(query, 'next_attempt_at=lte.');
      const rows = queue
        .filter((r) => r.state === 'pending')
        .filter((r) => dueBy === undefined || r.next_attempt_at <= dueBy)
        .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at));
      return Promise.resolve(rows.map((r) => ({ ...r })));
    }),
    update: vi.fn((table: string, patch: Record<string, unknown>, query: string) => {
      if (table === 'sync_job_state') {
        if ('state' in patch) jobStateCloses.push(patch);
        return Promise.resolve([{ job_name: 'client_list_sync' }]);
      }
      if (table === 'sync_run') {
        if ('finished_at' in patch) runCloses.push(patch);
        return Promise.resolve([]);
      }
      if (table !== 'sync_queue') return Promise.resolve([]);
      const id = param(query, 'id=eq.');
      const row = queue.find((r) => r.id === id);
      if (row === undefined) return Promise.resolve([]);
      if (query.includes('state=eq.pending') && row.state !== 'pending') {
        return Promise.resolve([]);
      }
      Object.assign(row, patch);
      return Promise.resolve([{ ...row }]);
    }),
    upsert: vi.fn((table: string, rows: Array<Record<string, unknown>>) => {
      if (table === 'sync_job_state') {
        jobState = { ...jobState, ...rows[0] };
        const first = rows[0];
        if (first !== undefined && 'state' in first) jobStateCloses.push(first);
      }
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
      t += ms;
      return Promise.resolve();
    },
  };
  return {
    deps,
    queue,
    runCloses,
    jobStateCloses,
    personWrites,
    countCalls: () => counts,
  };
}

describe('the post-drain count cannot orphan a run', () => {
  it('closes the run, keeps the work, and reports the count as unknown', async () => {
    const h = harness(true);
    const summary = await runClientListSyncPass(config, h.deps);

    // It reached the count at all, so the drain ran.
    expect(h.countCalls()).toBe(1);
    // The work happened, and a failed count does not undo it.
    expect(h.queue.map((r) => r.state)).toEqual(['done']);
    expect(h.personWrites).toHaveLength(1);

    // THE RUN CLOSED. This is the regression: it used to be left 'running'
    // until abandonStaleRuns retired it 30 minutes later. (The sweep that opens
    // every pass writes to sync_run too, so this looks at THIS run's close.)
    const closes = h.runCloses.filter((c) => c.state !== 'abandoned');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ items_remaining: UNKNOWN_REMAINING });
    expect(closes[0]).toHaveProperty('finished_at');

    // Not 'failed' - nothing about the work failed. Not 'ok' either: 'ok' moves
    // the completion watermark, and no count was taken to justify that.
    expect(summary.state).toBe('partial');
    expect(closes[0]).toMatchObject({ state: 'partial' });
    expect(h.jobStateCloses.at(-1)).toMatchObject({ state: 'paused' });

    // No error is invented: the failure was in the counting, not the syncing.
    expect(summary.error).toBeUndefined();
  });

  it('still reports ok when the count succeeds and finds nothing', async () => {
    const h = harness(false);
    const summary = await runClientListSyncPass(config, h.deps);

    expect(summary.state).toBe('ok');
    expect(summary.itemsRemaining).toBe(0);
    expect(h.runCloses.at(-1)).toMatchObject({ state: 'ok', items_remaining: 0 });
    expect(h.jobStateCloses.at(-1)).toMatchObject({ state: 'idle' });
  });
});
