import type { SupabaseClient } from '../supabase/client.js';

/**
 * "How much is left, and is anything moving" - answered from the queue.
 *
 * WHY A SEPARATE READ AND NOT THE SYNC RESPONSE. A sync invocation can only
 * report what IT did. The question a caller actually has while a backfill runs
 * is about the whole job: 40,333 items were queued for days on live dev while
 * every individual run returned `ok`, because each run only ever described its
 * own fifty seconds. This reads the durable state instead, so it is true
 * regardless of which process is working or whether any process is.
 *
 * CHEAP ON PURPOSE. Two view reads, no table scans, nothing that grows with the
 * queue - the whole point is that a client can poll it every few seconds without
 * thinking about cost. sync_queue_progress (migration 0025) already aggregates
 * per work_type; this adds the run-level view and the totals.
 */

export interface StageProgress {
  readonly work_type: string;
  readonly pending: number;
  readonly in_progress: number;
  readonly done: number;
  readonly failed: number;
  readonly dead: number;
  readonly total: number;
  readonly pct_done: number;
  /** Oldest item still not finished, or null when the stage is drained. */
  readonly oldest_unfinished: string | null;
}

export interface RunProgress {
  readonly run_id: string;
  readonly job_name: string;
  readonly state: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly items_remaining: number | null;
  readonly rows_failed: number | null;
  readonly error: string | null;
}

/**
 * Read caps, explicit because PostgREST silently returns its first 1,000 rows
 * otherwise - the failure this project has a structural test for.
 *
 * STAGES is one row per work_type: sixteen today. 200 is far above any plausible
 * number of stages, so hitting it means something is wrong rather than large.
 *
 * OPEN_RUNS is capped low and the caller is TOLD when it truncated, because open
 * runs are not naturally bounded: a run is closed by the process that opened it,
 * so every process that died left one behind. Forty were open on live dev. A
 * silently-cut list would read as "a few runs are working".
 */
const STAGE_LIMIT = 200;
const OPEN_RUN_LIMIT = 50;

export interface SyncProgress {
  /** True when nothing anywhere is pending or in progress. */
  readonly complete: boolean;
  readonly totals: {
    readonly pending: number;
    readonly in_progress: number;
    readonly done: number;
    readonly failed: number;
    readonly dead: number;
    readonly total: number;
    readonly pct_done: number;
  };
  /** Per work_type, worst-first: whatever has the most left to do leads. */
  readonly stages: readonly StageProgress[];
  /**
   * Runs still open. A run is closed by the process that opened it, so anything
   * here either IS working or DIED working - and those look identical from
   * outside. `started_at` is the only way to tell: 40 runs sat open on live dev,
   * the oldest ten days, every one of them a corpse.
   */
  readonly openRuns: readonly RunProgress[];
  /** True when there are more open runs than the list shows. */
  readonly openRunsTruncated: boolean;
  readonly recentRuns: readonly RunProgress[];
}

const STAGE_COLUMNS =
  'work_type,pending,in_progress,done,failed,dead,total,pct_done,oldest_unfinished';
const RUN_COLUMNS =
  'run_id,job_name,state,started_at,finished_at,items_remaining,rows_failed,error';

export async function readSyncProgress(
  db: SupabaseClient,
  kBusiness: string,
  recentLimit = 20,
): Promise<SyncProgress> {
  const [stages, openRuns, recentRuns] = await Promise.all([
    db.select<StageProgress>(
      'sync_queue_progress',
      `k_business=eq.${kBusiness}&select=${STAGE_COLUMNS}` +
        `&order=pending.desc&limit=${String(STAGE_LIMIT)}`,
    ),
    // One extra so truncation is detectable rather than assumed.
    db.select<RunProgress>(
      'sync_run',
      `state=eq.running&select=${RUN_COLUMNS}` +
        `&order=started_at.asc&limit=${String(OPEN_RUN_LIMIT + 1)}`,
    ),
    db.select<RunProgress>(
      'sync_run',
      `select=${RUN_COLUMNS}&order=started_at.desc&limit=${String(recentLimit)}`,
    ),
  ]);

  const add = (f: (s: StageProgress) => number): number =>
    stages.reduce((sum, s) => sum + (Number(f(s)) || 0), 0);

  const pending = add((s) => s.pending);
  const inProgress = add((s) => s.in_progress);
  const done = add((s) => s.done);
  const total = add((s) => s.total);

  return {
    // Drained, not "the last run said ok". A run reporting success while work
    // remains is exactly the failure this exists to make visible.
    complete: pending === 0 && inProgress === 0,
    totals: {
      pending,
      in_progress: inProgress,
      done,
      failed: add((s) => s.failed),
      dead: add((s) => s.dead),
      total,
      // Rounded to whole percent: a caller polling this is drawing a bar, not
      // doing arithmetic on it.
      pct_done: total === 0 ? 100 : Math.floor((done / total) * 100),
    },
    stages,
    openRuns: openRuns.slice(0, OPEN_RUN_LIMIT),
    openRunsTruncated: openRuns.length > OPEN_RUN_LIMIT,
    recentRuns,
  };
}
