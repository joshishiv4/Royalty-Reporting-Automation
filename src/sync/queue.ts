import type { GhlRequestError } from '../ghl/client.js';
import { SupabaseError, type SupabaseClient } from '../supabase/client.js';
import { runBatch } from '../wl/batch.js';
import { WlRequestError } from '../wl/client.js';

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
 * THE CLAIMED BATCH IS CLAIMED AND PROCESSED CONCURRENTLY (opts.concurrency). One
 * invocation is still one worker; within it, the items are independent (one WL
 * call plus a few DB writes each), so a serial loop idled the network the whole
 * time - measured ~2.35s/item, ~7 hours for a 10k receipt backfill. A bounded
 * pool takes that to ~7x. WL publishes no rate limit; the ceiling is the database,
 * and a transient DB error requeues one item (see outcomeFromError) rather than
 * failing the pass, so raising concurrency is safe.
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
  | { readonly kind: 'dead'; readonly failure: FailureInfo }
  /**
   * Not done, not failed - come back later. Used by an async job that is WAITING
   * on something out of its hands (a WellnessLiving report still building), so it
   * must release the worker rather than sit in a poll loop and burn the 60s
   * function budget. Unlike 'requeue' it records NO error and does NOT advance
   * attempt_count: waiting is not failing, and the wait is bounded by the job's
   * own deadline, not by the dead-letter ladder.
   */
  | { readonly kind: 'defer'; readonly requeueAfterMs: number };

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
  /**
   * How many claimed items to claim and process AT ONCE. Each item is one WL call
   * plus several DB writes, all independent between items, so a serial loop idles
   * the network the whole time - measured 27 Aug 2026 at ~2.35s/item, ~7 hours for
   * a 10k receipt backfill. A bounded pool processes N at a time. Defaults to 1
   * (unchanged, serial) so existing callers and tests are untouched; the pass sets
   * it. WL publishes no rate limit; the real ceiling is the database, and a
   * transient DB error now requeues one item rather than failing the pass.
   */
  readonly concurrency?: number;
}

export interface QueueSummary {
  readonly claimed: number;
  readonly done: number;
  readonly requeued: number;
  readonly dead: number;
  /** Items that asked to be polled again later (see Outcome 'defer'). */
  readonly deferred: number;
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
 * How long to wait before retrying an item whose DATABASE write hit a transient
 * error. Short and fixed: unlike WellnessLiving, Supabase is not rate-limiting us
 * on a ladder - it is momentarily unavailable under concurrent load - so a brief
 * spacing is enough, and `attempt_count` still widens it if the pressure persists.
 */
export const SUPABASE_TRANSIENT_REQUEUE_MS = 30_000;

/**
 * The one place a handler turns a thrown error into a queue outcome, so a single
 * failure requeues ONE item instead of aborting a whole pass.
 *
 * WHY THIS EXISTS. A handler's catch used to be `if (WlRequestError) ...; throw`.
 * That threw for anything else - and a transient `SupabaseError` (a free-tier DB
 * hiccup under the parallel run) is exactly "anything else". runQueue does not
 * catch a handler, so the throw reached runPass's outer catch and the ENTIRE pass
 * came back 'failed', its remaining thousands of items left pending. Measured
 * live 27 Aug 2026: receipt_sync - the heaviest writer, ~9 DB calls per item -
 * failed on a single DB blip with 10,938 purchases still unpriced, while lighter
 * passes survived. This makes a transient DB error behave like a transient WL
 * error: requeue the item, keep draining.
 *
 * Returns null for anything it does not own (a non-transient SupabaseError - a
 * constraint or bad column - or an unexpected error), so the caller rethrows and
 * a real bug still surfaces loudly rather than being requeued forever.
 */
export function outcomeFromError(
  error: unknown,
): Extract<Outcome, { kind: 'requeue' | 'dead' }> | null {
  if (error instanceof WlRequestError) return outcomeFromWlError(error);
  if (error instanceof SupabaseError && error.isTransient) {
    return {
      kind: 'requeue',
      requeueAfterMs: SUPABASE_TRANSIENT_REQUEUE_MS,
      failure: {
        message: error.message,
        sid: null,
        httpStatus: error.httpStatus,
        // The queue's traceId column is ours; a DB error has no WL/GHL trace, so
        // name the table it failed on - enough to find it without a host.
        traceId: `supabase:${error.table}`,
        kLog: null,
      },
    };
  }
  return null;
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

  // Each claim is an independent compare-and-swap on a distinct id, so they run
  // concurrently: a serial claim loop would otherwise be the bottleneck once the
  // batch size is raised. A CAS that loses the race returns nothing and is simply
  // absent from the result (not a failure); order is preserved by runBatch.
  const claim = await runBatch(
    candidates,
    async (c): Promise<QueueItem | null> => {
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
      return rows.length === 1 ? rows[0]! : null;
    },
    { concurrency: Math.max(1, opts.concurrency ?? 1) },
  );
  return claim.results.filter((r): r is QueueItem => r !== null);
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

  // Defer: back to pending for a later poll, but NOT a failure - no error columns,
  // and attempt_count is untouched so a slow report never dead-letters itself.
  if (outcome.kind === 'defer') {
    const nextAttemptAt = new Date(Date.parse(now) + outcome.requeueAfterMs).toISOString();
    await db.update(
      'sync_queue',
      {
        state: 'pending',
        next_attempt_at: nextAttemptAt,
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
      },
      `id=eq.${item.id}`,
    );
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

  // Items are independent, so process a bounded pool of them at once instead of
  // one-at-a-time. A handler returns an Outcome (it does not throw for a data
  // reason - the pass handlers convert WL and transient-DB failures via
  // outcomeFromError); settle applies it. runBatch isolates any UNEXPECTED throw
  // as a failure so one does not lose the others.
  const processed = await runBatch(
    items,
    async (item): Promise<Outcome['kind']> => {
      const outcome = await handler(item, db);
      await settle(db, item, outcome, opts.now);
      return outcome.kind;
    },
    { concurrency: Math.max(1, opts.concurrency ?? 1) },
  );

  let done = 0;
  let requeued = 0;
  let dead = 0;
  let deferred = 0;
  for (const kind of processed.results) {
    if (kind === 'done') done += 1;
    else if (kind === 'requeue') requeued += 1;
    else if (kind === 'defer') deferred += 1;
    else dead += 1;
  }

  // An unexpected error (not a handled Outcome) is a real bug, not transient
  // pressure - surface it so the pass fails loudly rather than spinning on a
  // reclaim-retry loop forever. The items it hit stay claimed and are reclaimed
  // when their lease expires.
  if (processed.failures.length > 0) throw processed.failures[0]!.error;

  return { claimed: items.length, done, requeued, dead, deferred, reclaimed };
}

function targetKey(i: { work_type: string; target_key: string; k_business: string }): string {
  return `${i.work_type}|${i.target_key}|${i.k_business}`;
}
