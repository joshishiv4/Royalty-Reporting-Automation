import type { GhlRequestError } from '../ghl/client.js';
import type { SupabaseClient } from '../supabase/client.js';
import type { WlRequestError } from '../wl/client.js';

/**
 * The durable work loop over `sync_queue`.
 *
 * A Vercel function is capped at 60s while a full sync is budgeted in hours, so a
 * run WILL be cut off mid-way as routine. Nothing that matters lives in memory:
 * an item's state, its next attempt time and its last error are all columns, so
 * the next invocation carries on exactly where this one stopped.
 *
 * CLAIMING IS COMPARE-AND-SWAP, not a lock. One worker per invocation (the M03
 * decision), so the only race is between overlapping invocations. Each claim is a
 * conditional PATCH - `id=X AND state=pending` - and an empty result means another
 * worker got there first. No SELECT FOR UPDATE, no RPC, no migration.
 *
 * THE LADDER IS THE CLIENT'S. `attempt_count` is passed to the WL client as
 * `priorAttempt`, which picks the 1 / 5 / 25 minute requeue rung; on requeue the
 * count is incremented, so a repeatedly-failing item widens its own spacing and
 * finally dead-letters. See src/wl/client.ts and PRD task 009 decision 4.
 */

/** A claimable unit of work. Fields the loop reads; the table has more. */
export interface QueueItem {
  readonly id: string;
  readonly work_type: string;
  readonly target_key: string;
  readonly k_business: string;
  readonly attempt_count: number;
}

/** What WL last said, for the queue's `last_error*` columns and a support ticket. */
export interface FailureInfo {
  readonly message: string;
  readonly sid: string | null;
  readonly httpStatus: number | null;
  readonly traceId: string;
  readonly kLog: string | null;
}

/** What a handler decided happened. It must NOT throw for control flow. */
export type Outcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'requeue'; readonly requeueAfterMs: number; readonly failure: FailureInfo }
  | { readonly kind: 'dead'; readonly failure: FailureInfo };

export type QueueHandler = (item: QueueItem, db: SupabaseClient) => Promise<Outcome>;

export interface RunQueueOptions {
  /** Current time as an ISO string. Injected so tests do not depend on wall time. */
  readonly now: string;
  /** Identifies the claiming worker in `claimed_by`. Usually the run id. */
  readonly workerId: string;
  /** How many items to claim this pass. */
  readonly limit: number;
  /** Lease length in ms; a claim past it is reclaimable. Keep it > the step budget. */
  readonly leaseMs: number;
  /**
   * Only claim these work types. A pass handles one kind of work; without this it
   * would claim another job's items and hand them to the wrong handler - e.g. a
   * purchase pass grabbing a leftover staff_list item and reading its target_key
   * as a uid.
   */
  readonly workTypes: readonly string[];
}

export interface QueueSummary {
  readonly claimed: number;
  readonly done: number;
  readonly requeued: number;
  readonly dead: number;
  readonly reclaimed: number;
}

const ITEM_COLUMNS = 'id,work_type,target_key,k_business,attempt_count';

/** Turns a WL failure into the queue outcome its retry guidance dictates. */
export function outcomeFromWlError(
  error: WlRequestError,
): Extract<Outcome, { kind: 'requeue' | 'dead' }> {
  const failure: FailureInfo = {
    message: error.message,
    sid: error.details.sid,
    httpStatus: error.details.httpStatus,
    traceId: error.details.traceId,
    kLog: error.details.kLog,
  };
  // Null requeue guidance means the ladder is spent or the failure is permanent:
  // dead-letter rather than retry forever.
  return error.details.requeueAfterMs === null
    ? { kind: 'dead', failure }
    : { kind: 'requeue', requeueAfterMs: error.details.requeueAfterMs, failure };
}

/**
 * The same mapping for GoHighLevel, and the reason it exists at all.
 *
 * GoHighLevel is SUPPLEMENTARY - WellnessLiving is the system of record. So an
 * outage there must degrade to stale data, never to a failed sync run. Before
 * this existed a GHL error was rethrown, runQueue does not catch a handler, and
 * the throw reached runPass's outer catch: the whole pass came back 'failed' and
 * the drain loop stopped, so an outage at a supplementary service could halt
 * work that had nothing to do with it. Measured live on dev, not inferred.
 *
 * 'auth' requeues rather than dying. A token blip would otherwise dead-letter
 * every client at once, and the queue's own attempt ladder is what should decide
 * when to give up - not the first bad response.
 */
export function outcomeFromGhlError(
  error: GhlRequestError,
  requeueAfterMs: number,
): Extract<Outcome, { kind: 'requeue' | 'dead' }> {
  const failure: FailureInfo = {
    message: error.message,
    sid: null,
    httpStatus: error.details.httpStatus,
    // GHL has no k_log; its own trace id is carried in the message the client
    // built, and the queue's traceId column is ours.
    traceId: error.details.path,
    kLog: null,
  };
  // 'permanent' is about THIS request - a malformed filter, a 404 - so retrying
  // it forever would be noise. Anything else is about the service.
  return error.kind === 'permanent'
    ? { kind: 'dead', failure }
    : { kind: 'requeue', requeueAfterMs, failure };
}

/**
 * How recently a 'done' row of the same target counts as "already synced",
 * measured in ms. A target completed within this window is skipped by enqueue.
 *
 * 24 hours is the intended re-fetch cadence: a daily cron catches the day's
 * changes and nothing more. Longer would delay real updates; shorter would let
 * repeated invocations within a day re-fetch the same target - the exact waste
 * observed live (7 sync runs in ~9 hours grew the queue from ~2k rows to ~28k).
 */
export const DEFAULT_FRESH_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Adds work, skipping targets already synced.
 *
 * The partial unique index (work_type, target_key, k_business WHERE active) is
 * the real backstop; this pre-filter keeps a normal enqueue from tripping it,
 * AND from wastefully re-seeding a target that was successfully fetched
 * recently.
 *
 * SCOPED BY WORK_TYPE AND BUSINESS. An earlier draft read every active row in
 * the queue to build `seen`. PostgREST caps a select at 1000 rows by default,
 * and once the queue holds more active items than that across all work_types
 * (measured: 2,755 during a heavy day's four heavy passes), the check silently
 * missed rows and the follow-up insert tripped the unique index on the misses.
 * A pass would then fail its whole seed with a SupabaseError and drain nothing.
 *
 * Every call passes items of ONE work_type (per pass.ts), so scoping the check
 * to that work_type is both cheaper and correct - it never needs to see other
 * queues to answer "does this target already exist for THIS work_type". The
 * k_business scope matters for the same reason: the unique index includes it,
 * and two businesses' targets share a key namespace.
 *
 * DEDUPS AGAINST RECENT DONE ROWS, TOO. The unique index does NOT cover 'done'
 * (the partial predicate excludes it), so a target with only a done row could
 * still be re-inserted and would sit at the end of the queue as another
 * pending row - waste, not a crash. Measured live: after seven full-sync runs
 * fired in nine hours, purchase_list grew from 517 rows to 3,737, and
 * client_visits from 517 to 5,307. Skipping targets last completed inside a
 * fresh-done window keeps the daily cron behaviour honest (one refresh per
 * day) while making repeated same-day invocations a no-op instead of a
 * multiplier.
 *
 * FORCE-RESEED WHEN THE CALLER INSISTS. Set `opts.forceReseed = true` when the
 * caller has explicitly asked for a refresh regardless of freshness - the GHL
 * matcher's `retryUnresolved` path is exactly this case. The unique-index
 * check on active items is preserved; only the fresh-done skip is dropped.
 */
export interface EnqueueOptions {
  /**
   * Skip targets with a 'done' row updated within this many ms. Defaults to
   * DEFAULT_FRESH_DONE_WINDOW_MS (24 hours). Set to 0 to disable the check
   * entirely - equivalent to the old always-reseed behaviour.
   */
  readonly freshDoneWindowMs?: number;
  /** Ignore the fresh-done window - useful for explicit human-initiated refreshes. */
  readonly forceReseed?: boolean;
  /**
   * Reference time, used to compute the fresh-done cutoff. Defaults to
   * Date.now(). Injectable so tests do not depend on wall time.
   */
  readonly now?: () => number;
}

export async function enqueue(
  db: SupabaseClient,
  items: ReadonlyArray<{ work_type: string; target_key: string; k_business: string }>,
  nextAttemptAt?: string,
  opts: EnqueueOptions = {},
): Promise<number> {
  if (items.length === 0) return 0;
  const workTypes = [...new Set(items.map((i) => i.work_type))];
  const businesses = [...new Set(items.map((i) => i.k_business))];

  const seen = new Set<string>();

  // PAGINATED. A single work_type can hold more than PostgREST's 1000-row cap
  // during a heavy backfill (receipt_sync sat at 1,301 active on live dev, and
  // grew past that during the run). If the dedupe read is capped, the misses
  // fall into the insert below and trip the unique index. Loop until a short
  // page comes back, so the check is complete no matter how deep the queue is.
  const PAGE = 1000;
  const scope = `work_type=in.(${workTypes.join(',')})&k_business=in.(${businesses.join(',')})`;

  for (let offset = 0; ; offset += PAGE) {
    const page = await db.select<{ work_type: string; target_key: string; k_business: string }>(
      'sync_queue',
      `${scope}&state=in.(pending,in_progress)&order=id.asc&limit=${PAGE}&offset=${offset}` +
        `&select=work_type,target_key,k_business`,
    );
    for (const row of page) seen.add(targetKey(row));
    if (page.length < PAGE) break;
  }

  // Fresh-done window: a target completed inside it is treated as already
  // covered and NOT re-enqueued. Skipped entirely on an explicit force-reseed.
  const forceReseed = opts.forceReseed === true;
  const windowMs = opts.freshDoneWindowMs ?? DEFAULT_FRESH_DONE_WINDOW_MS;
  if (!forceReseed && windowMs > 0) {
    const now = opts.now?.() ?? Date.now();
    const cutoff = new Date(now - windowMs).toISOString();
    for (let offset = 0; ; offset += PAGE) {
      const page = await db.select<{
        work_type: string;
        target_key: string;
        k_business: string;
      }>(
        'sync_queue',
        `${scope}&state=eq.done&updated_at=gte.${cutoff}` +
          `&order=id.asc&limit=${PAGE}&offset=${offset}` +
          `&select=work_type,target_key,k_business`,
      );
      for (const row of page) seen.add(targetKey(row));
      if (page.length < PAGE) break;
    }
  }

  const fresh = items.filter((i) => !seen.has(targetKey(i)));
  if (fresh.length > 0) {
    // Set next_attempt_at from the caller's clock, not the DB default. The claim
    // filters on this same clock, so relying on the server's now() makes a fresh
    // item look not-yet-eligible whenever the two clocks differ by a hair.
    await db.insert(
      'sync_queue',
      fresh.map((i) => ({
        ...i,
        state: 'pending',
        ...(nextAttemptAt === undefined ? {} : { next_attempt_at: nextAttemptAt }),
      })),
    );
  }
  return fresh.length;
}

/** Flips leases that outlived their claim back to pending, so nothing strands. */
export async function reclaimExpired(db: SupabaseClient, now: string): Promise<number> {
  const rows = await db.update(
    'sync_queue',
    { state: 'pending', claimed_by: null, claimed_at: null, claim_expires_at: null },
    `state=eq.in_progress&claim_expires_at=lt.${now}&select=id`,
  );
  return rows.length;
}

/** Claims up to `limit` eligible items under a lease, compare-and-swap per item. */
export async function claimBatch(db: SupabaseClient, opts: RunQueueOptions): Promise<QueueItem[]> {
  const expiresAt = new Date(Date.parse(opts.now) + opts.leaseMs).toISOString();
  const workTypeFilter = `&work_type=in.(${opts.workTypes.join(',')})`;
  const candidates = await db.select<QueueItem>(
    'sync_queue',
    `state=eq.pending&next_attempt_at=lte.${opts.now}${workTypeFilter}` +
      `&order=next_attempt_at.asc&limit=${String(opts.limit)}&select=${ITEM_COLUMNS}`,
  );

  const claimed: QueueItem[] = [];
  for (const c of candidates) {
    // Conditional on state=pending: an empty result means someone else claimed it.
    const rows = await db.update<QueueItem>(
      'sync_queue',
      {
        state: 'in_progress',
        claimed_by: opts.workerId,
        claimed_at: opts.now,
        claim_expires_at: expiresAt,
      },
      `id=eq.${c.id}&state=eq.pending&select=${ITEM_COLUMNS}`,
    );
    if (rows.length === 1) claimed.push(rows[0]!);
  }
  return claimed;
}

/** Applies a handler's outcome to the item's queue row. */
export async function settle(
  db: SupabaseClient,
  item: QueueItem,
  outcome: Outcome,
  now: string,
): Promise<void> {
  if (outcome.kind === 'done') {
    await db.update('sync_queue', { state: 'done' }, `id=eq.${item.id}`);
    return;
  }

  const errorColumns = {
    last_error: outcome.failure.message,
    last_error_sid: outcome.failure.sid,
    last_http_status: outcome.failure.httpStatus,
    last_trace_id: outcome.failure.traceId,
    last_k_log: outcome.failure.kLog,
  };

  if (outcome.kind === 'dead') {
    await db.update('sync_queue', { state: 'dead', ...errorColumns }, `id=eq.${item.id}`);
    return;
  }

  // Requeue: widen from the rung the client already chose, and advance the count
  // so the NEXT failure lands a rung further out (decision 4).
  const nextAttemptAt = new Date(Date.parse(now) + outcome.requeueAfterMs).toISOString();
  await db.update(
    'sync_queue',
    {
      state: 'pending',
      next_attempt_at: nextAttemptAt,
      attempt_count: item.attempt_count + 1,
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
      ...errorColumns,
    },
    `id=eq.${item.id}`,
  );
}

/** One pass: reclaim strays, claim a batch, run and settle each item. */
export async function runQueue(
  db: SupabaseClient,
  handler: QueueHandler,
  opts: RunQueueOptions,
): Promise<QueueSummary> {
  const reclaimed = await reclaimExpired(db, opts.now);
  const items = await claimBatch(db, opts);

  let done = 0;
  let requeued = 0;
  let dead = 0;
  for (const item of items) {
    const outcome = await handler(item, db);
    await settle(db, item, outcome, opts.now);
    if (outcome.kind === 'done') done += 1;
    else if (outcome.kind === 'requeue') requeued += 1;
    else dead += 1;
  }

  return { claimed: items.length, done, requeued, dead, reclaimed };
}

function targetKey(i: { work_type: string; target_key: string; k_business: string }): string {
  return `${i.work_type}|${i.target_key}|${i.k_business}`;
}
