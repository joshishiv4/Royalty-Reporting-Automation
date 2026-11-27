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
  /** The pause between tries of one chunk. Injectable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * How many rows one `enqueue_sync_items` statement carries.
 *
 * 200, DOWN FROM 500, AND THE REASON IS MEASURED. On 26 Nov 2026 (the 23:39 UTC
 * hourly run; STATUS.md names it) attendance_sync's seed had ~22,000 sessions to
 * queue.
 * Thirty chunks of 500 went in during a 128-second seed - seconds apiece, against
 * a statement timeout that cancels at about nine - and the 31st was cancelled:
 * `57014: canceling statement due to statement timeout
 * [table=enqueue_sync_items]`. The table held only ~172,000 rows by then; the
 * cost was bloat, not row count (migration 0074).
 *
 * At the same per-row cost a 200-row statement takes under two seconds, about a
 * fifth of the timeout. 100 was written first and would double that margin; 200
 * was chosen on 27 Nov to halve the round trips - 110 for that seed, not 220 -
 * while keeping the statement well clear of the size that failed. Either way
 * the extra round trips over 500 (44 for that seed) cost seconds, on a pass that
 * then spends an hour calling WellnessLiving.
 */
export const ENQUEUE_CHUNK = 200;

/**
 * How many times one chunk is tried before the seed gives up.
 *
 * A RETRY IS SAFE HERE, WHICH IS WHY THERE IS ONE. `enqueue_sync_items` is a
 * single statement with a bare ON CONFLICT DO NOTHING (0032). Cancelled, it
 * inserted nothing. Committed with the answer lost on the way back, its rows are
 * active and the second try skips every one of them. Either way a chunk can be
 * sent again without queueing anything twice.
 *
 * WHY IT MATTERS. The seed runs before the pass claims anything, so one chunk
 * that timed out failed the whole pass with everything already queued left
 * untouched until the next run - 15,000 items on 26 Nov, when the hourly sync
 * was in practice starting only every four to ten hours.
 *
 * Only a transient error is retried (`SupabaseError.isTransient`: a statement
 * timeout comes back as HTTP 500, a network failure as no status). A 4xx is a
 * bug, and trying a bug three times is three failures.
 */
export const ENQUEUE_CHUNK_ATTEMPTS = 3;

/** The pause before the second try; the third waits twice as long. */
export const ENQUEUE_RETRY_PAUSE_MS = 2_000;

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

  // Ordered by (work_type, target_key, k_business), NOT id: that is the order
  // sync_queue_active_target_key (0007) holds, so Postgres reads it straight off
  // the index. Ordered by id, the planner walks the primary key instead - the
  // same trap as the fresh-done read below. On 1 Oct 2026 session_attendance
  // (16,608 pending) timed out ordered by id on every try and took 353 ms in
  // index order; it was killing attendance_sync before it claimed anything.
  const ACTIVE_ORDER = 'order=work_type.asc,target_key.asc,k_business.asc';
  for (let offset = 0; ; offset += PAGE) {
    const page = await db.select<{ work_type: string; target_key: string; k_business: string }>(
      'sync_queue',
      `${scope}&state=in.(pending,in_progress)&${ACTIVE_ORDER}&limit=${PAGE}&offset=${offset}` +
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
    // Ordered by updated_at, NOT id. sync_queue_fresh_done_idx (0050) holds
    // these rows in updated_at order, so this reads only the window's slice.
    // Ordered by id, the planner walks the primary key hoping to hit 1000
    // matches early - and when the window is empty it never does: on 1 Oct 2026
    // purchase_item_element (243,475 done, none fresh) took 310 ms unordered and
    // hit the statement timeout ordered by id. id stays as the tie-break so the
    // pages are stable; a row finishing mid-read lands at the end, not mid-page.
    for (let offset = 0; ; offset += PAGE) {
      const page = await db.select<{
        work_type: string;
        target_key: string;
        k_business: string;
      }>(
        'sync_queue',
        `${scope}&state=eq.done&updated_at=gte.${cutoff}` +
          `&order=updated_at.asc,id.asc&limit=${PAGE}&offset=${offset}` +
          `&select=work_type,target_key,k_business`,
      );
      for (const row of page) seen.add(targetKey(row));
      if (page.length < PAGE) break;
    }
  }

  // Deduped against the batch itself as well as against the database. The read
  // above only knows what is already stored; a caller handing the same target in
  // twice would collide with ITSELF inside one insert.
  const fresh = items.filter((i) => {
    const key = targetKey(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (fresh.length === 0) return 0;

  // ONE ATOMIC STATEMENT, NOT A READ FOLLOWED BY A WRITE. The dedupe above is a
  // read and this is a later write, with nothing holding between them. Two
  // overlapping runs of one pass had the other draining rows pending -> done
  // while this one paged the dedupe read, so that read skipped rows and the
  // insert collided: `23505: duplicate key ... sync_queue_active_target_key`,
  // which killed attendance_sync outright on 31 Aug 2026 with 32,440 items left
  // unqueued.
  //
  // The database resolves it instead. `enqueue_sync_items` is an INSERT with a
  // bare ON CONFLICT DO NOTHING (migration 0032) - a duplicate means the target
  // already has an active item, which is exactly the state the partial unique
  // index exists to guarantee, so skipping is the correct answer rather than a
  // swallowed error. It has to be a function: PostgREST cannot express ON
  // CONFLICT DO NOTHING against a PARTIAL index, and all three of its routes
  // were probed live and fail (see the migration).
  //
  // The dedupe read stays because it saves sending tens of thousands of rows the
  // database would only discard. It is no longer load-bearing for correctness.
  //
  // next_attempt_at comes from the caller's clock, not the DB default: the claim
  // filters on that same clock, so relying on the server's now() makes a fresh
  // item look not-yet-eligible whenever the two differ by a hair.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let inserted = 0;
  for (let start = 0; start < fresh.length; start += ENQUEUE_CHUNK) {
    const chunk = fresh.slice(start, start + ENQUEUE_CHUNK).map((i) => ({
      ...i,
      ...(nextAttemptAt === undefined ? {} : { next_attempt_at: nextAttemptAt }),
    }));
    // The SAME chunk again, never a re-read: see ENQUEUE_CHUNK_ATTEMPTS on why
    // sending it twice cannot queue anything twice.
    for (let attempt = 1; ; attempt += 1) {
      try {
        inserted += await db.rpc<number>('enqueue_sync_items', { items: chunk });
        break;
      } catch (error) {
        const transient = error instanceof SupabaseError && error.isTransient;
        if (!transient || attempt >= ENQUEUE_CHUNK_ATTEMPTS) throw error;
        await sleep(ENQUEUE_RETRY_PAUSE_MS * attempt);
      }
    }
  }
  // What was actually added, not what we hoped to add: the difference is the
  // races the dedupe read missed, and reporting the optimistic number would hide
  // exactly the thing worth noticing. One case reads low: a chunk that committed
  // but whose answer was lost is retried, and the retry reports 0 for rows the
  // first try did insert.
  return inserted;
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

/**
 * How long a 'done' row is kept before `pruneDoneItems` removes it.
 *
 * THREE DAYS, AND THE FLOOR IS TWENTY-FOUR HOURS. Anything inside
 * DEFAULT_FRESH_DONE_WINDOW_MS is load-bearing: enqueue reads today's 'done'
 * rows to decide whether a target has already been refreshed, so pruning into
 * that window makes the dedupe blind and re-queues work the same day. Past it a
 * 'done' row has no reader at all - the dedupe cannot see it, and the claim and
 * countEligible both filter on 'pending'. Three days keeps two clear days of
 * margin over the floor for a debugging session, and nothing more.
 *
 * WHY NOT TWENTY ANY MORE. Twenty was 0063's window (13 Oct 2026). At ~58,000
 * rows a day it HOLDS about 1.16M rows - and on 26 Nov 2026, with the table at
 * that size, client_session_sync failed with a statement timeout on sync_queue:
 * the same failure 0063 was written for, at 1,506,074 rows. Three days holds
 * about 175,000.
 *
 * WHY ANY OF THIS. sync_queue was never pruned. It reached 1,506,074 'done' rows
 * by 13 Oct 2026, at which point count(*) over the table no longer completed
 * (cancelled at 10,141 ms) and attendance_sync failed inside enqueue_sync_items
 * with a statement timeout, leaving 3,500 items unqueued. Two indexes (0050,
 * 0060) each moved that bottleneck without shrinking the table.
 */
export const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The most rows sync_queue should hold, whatever the age rule left.
 *
 * A SAFETY NET, NOT THE RULE. At today's volume the 3-day window keeps the table
 * near 175,000 rows and this never fires. It is for the day that is not normal -
 * a backfill or a re-seed that queues several days' worth at once - when the age
 * rule alone would let the table cross the size at which statements started
 * timing out (~1.16M on 26 Nov, ~1.5M on 13 Oct). 300,000 is well under both.
 *
 * It removes the OLDEST 'done' rows and nothing else, and never inside the
 * 24-hour floor: if the last day alone is over the cap, that is reported as
 * `overCap`, not "fixed" by blinding the dedupe.
 */
export const DEFAULT_QUEUE_ROW_CAP = 300_000;

/**
 * How old a resolved 'dead' row must be before it is removed.
 *
 * TWO DAYS, AND IT MUST STAY UNDER DEFAULT_RETENTION_MS. "Resolved" is proved by
 * a LATER 'done' row for the same target, and that row is itself pruned after
 * the retention window (3 days). A dead row waiting longer than that would
 * usually outlive its own proof and never be removed - the 7 days first proposed
 * on 26 Nov 2026 would have cleared almost nothing. With the wait under the
 * window, every resolution is visible to at least one hourly run while the dead
 * row is old enough: the done row lives from when it finished until 3 days
 * later, and it always finishes after the dead row died. pruneQueue runs this
 * step BEFORE the age rule for the same reason.
 *
 * Two days still gives the 06:00 sweep two mornings to report the failure
 * before the record of it goes. A 'dead' row with no later 'done' row is never
 * removed.
 */
export const DEFAULT_RESOLVED_DEAD_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

/** How many rows one prune statement removes. See 0063 on why this is batched. */
export const DEFAULT_PRUNE_BATCH = 5000;

export interface PruneOptions {
  /** Rows completed before this are removed. Defaults to now - DEFAULT_RETENTION_MS. */
  readonly before?: string;
  readonly batch?: number;
  /** Stops after this many statements, so one run cannot loop unbounded. */
  readonly maxBatches?: number;
  /** Count what WOULD go without removing it. */
  readonly dryRun?: boolean;
  readonly now?: () => number;
}

/**
 * Removes 'done' rows past the retention window, a batch per statement.
 *
 * LOOPS RATHER THAN ONE DELETE, for the reason 0063 spells out: a single
 * statement over a million rows hits the same timeout this exists to prevent,
 * and holds locks on a table seventeen passes are using. Each call takes
 * `batch` rows and returns how many it got; fewer than asked means the window
 * is clear and the loop stops.
 *
 * `maxBatches` is a stop, not a target. The first run has a backlog that will
 * not clear in one pass, and a loop with no bound is how a cleanup becomes an
 * outage.
 */
export async function pruneDoneItems(
  db: SupabaseClient,
  opts: PruneOptions = {},
): Promise<{ readonly removed: number; readonly batches: number; readonly done: boolean }> {
  const now = opts.now ?? (() => Date.now());
  const before = opts.before ?? new Date(now() - DEFAULT_RETENTION_MS).toISOString();
  const batch = opts.batch ?? DEFAULT_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? 1000;

  if (opts.dryRun === true) {
    // The count is capped the same way countEligible's is: what matters is
    // whether there is work to do, not an exact figure nobody acts on.
    const rows = await db.select(
      'sync_queue',
      `state=eq.done&updated_at=lt.${before}&limit=${String(batch)}&select=id`,
    );
    return { removed: rows.length, batches: 0, done: rows.length < batch };
  }

  let removed = 0;
  let batches = 0;
  for (; batches < maxBatches;) {
    const n = await db.rpc<number>('prune_sync_queue', { p_before: before, p_limit: batch });
    batches += 1;
    removed += n;
    // Short batch means the window is clear. A zero would too, but stopping on
    // the short one saves a statement that is guaranteed to find nothing.
    if (n < batch) return { removed, batches, done: true };
  }
  return { removed, batches, done: false };
}

/**
 * Removes 'dead' rows whose target has been done since, a batch per statement.
 *
 * A dead row is final: the next sync queues the same target again as a NEW row
 * (enqueue_sync_items skips only targets with a pending or in_progress row). When
 * that row reaches 'done' the dead one is resolved - but it still reads as a live
 * problem to the alert sweep, whose parked total caps at 1,000 and was already
 * past it (1,001 dead rows, 26 Nov 2026). `prune_resolved_dead_sync_queue` (0073)
 * decides "resolved" in SQL; this only loops it.
 *
 * A dead row with no later 'done' row is still failing and is never removed.
 */
export async function pruneResolvedDeadItems(
  db: SupabaseClient,
  opts: Pick<PruneOptions, 'before' | 'batch' | 'maxBatches' | 'now'> = {},
): Promise<{ readonly removed: number; readonly batches: number; readonly done: boolean }> {
  const now = opts.now ?? (() => Date.now());
  const before = opts.before ?? new Date(now() - DEFAULT_RESOLVED_DEAD_RETENTION_MS).toISOString();
  const batch = opts.batch ?? DEFAULT_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? 1000;

  let removed = 0;
  let batches = 0;
  for (; batches < maxBatches;) {
    const n = await db.rpc<number>('prune_resolved_dead_sync_queue', {
      p_before: before,
      p_limit: batch,
    });
    batches += 1;
    removed += n;
    if (n < batch) return { removed, batches, done: true };
  }
  return { removed, batches, done: false };
}

export interface CapResult {
  /** The estimate the cap was measured against, before anything was removed. */
  readonly estimatedRows: number;
  readonly cap: number;
  readonly removed: number;
  /**
   * True when the table is still over the cap and the only 'done' rows left are
   * inside the 24-hour floor. Not fixable by deleting - it means a day's volume
   * alone exceeds the cap - so it is reported for a human, never forced.
   */
  readonly overCap: boolean;
}

/**
 * Brings sync_queue under `cap` rows by removing the oldest 'done' rows.
 *
 * THE SIZE IS AN ESTIMATE, READ ONCE. `sync_queue_estimated_rows` (0073) returns
 * n_live_tup, never count(*) - on this table count(*) is the statement that
 * stopped completing (cancelled at 10,141 ms, 13 Oct 2026). It is read once and
 * the excess worked off locally: the stats behind it trail a delete by up to a
 * second, so re-reading between batches could over-delete by a batch.
 *
 * NEVER INSIDE THE FLOOR. The cutoff is now - 24h, and prune_sync_queue clamps it
 * there again in SQL. If the oldest-first deletes come back short before the
 * excess is gone, everything older than a day is already gone and the cap cannot
 * be met without blinding enqueue's dedupe: that is `overCap`, for an alert.
 *
 * Runs AFTER the age prune, so on a normal day the estimate is under the cap and
 * this costs one cheap read.
 */
export async function enforceQueueCap(
  db: SupabaseClient,
  opts: { cap?: number; batch?: number; maxBatches?: number; now?: () => number } = {},
): Promise<CapResult> {
  const now = opts.now ?? (() => Date.now());
  const cap = opts.cap ?? DEFAULT_QUEUE_ROW_CAP;
  const batch = opts.batch ?? DEFAULT_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? 1000;

  const estimatedRows = Number(await db.rpc<number>('sync_queue_estimated_rows', {}));
  const excess = estimatedRows - cap;
  if (!(excess > 0)) return { estimatedRows, cap, removed: 0, overCap: false };

  const floor = new Date(now() - DEFAULT_FRESH_DONE_WINDOW_MS).toISOString();
  let removed = 0;
  let floorReached = false;
  for (let batches = 0; batches < maxBatches && removed < excess; batches += 1) {
    const want = Math.min(batch, excess - removed);
    const n = await db.rpc<number>('prune_sync_queue', { p_before: floor, p_limit: want });
    removed += n;
    // Short: nothing older than the floor is left to take.
    if (n < want) {
      floorReached = true;
      break;
    }
  }
  // Running out of maxBatches is NOT overCap: the next run carries on. Only the
  // floor - a day's volume alone over the cap - is something a human must see.
  return { estimatedRows, cap, removed, overCap: floorReached && removed < excess };
}

/** The job name a prune's sync_run row carries, so the alert sweep reports it. */
export const QUEUE_PRUNE_JOB = 'queue_prune';

export interface QueuePruneSummary {
  readonly done: { readonly removed: number; readonly batches: number; readonly done: boolean };
  readonly resolvedDead: {
    readonly removed: number;
    readonly batches: number;
    readonly done: boolean;
  };
  readonly cap: CapResult;
  /** 'failed' only for overCap; a thrown error is the caller's to record. */
  readonly state: 'ok' | 'partial' | 'failed';
}

/**
 * The whole maintenance step, in the order that keeps it cheap.
 *
 * 1. RESOLVED DEAD: 'dead' rows past 2 days whose target has been done since.
 *    FIRST, because the proof of "done since" is a 'done' row the next step may
 *    delete (see DEFAULT_RESOLVED_DEAD_RETENTION_MS).
 * 2. AGE: 'done' rows past the retention window (3 days).
 * 3. CAP: only then, if the table is still over the cap, the oldest 'done' rows
 *    down to the 24-hour floor. Last, because on a normal day the age rule
 *    already brought the table under it and this is one cheap read.
 *
 * NEVER 'pending' OR 'in_progress' - including an item mid-retry, which lives on
 * its original row as 'pending' with a later next_attempt_at. Every delete here
 * goes through a SQL function whose predicate names 'done' or 'dead' explicitly.
 *
 * `partial` when a step stopped at maxBatches (the next hourly run carries on);
 * `failed` only when the cap cannot be met without entering the floor.
 */
export async function pruneQueue(
  db: SupabaseClient,
  opts: {
    readonly retentionMs?: number;
    readonly resolvedDeadRetentionMs?: number;
    readonly cap?: number;
    readonly batch?: number;
    readonly maxBatches?: number;
    readonly now?: () => number;
  } = {},
): Promise<QueuePruneSummary> {
  const now = opts.now ?? (() => Date.now());
  const shared = {
    now,
    ...(opts.batch === undefined ? {} : { batch: opts.batch }),
    ...(opts.maxBatches === undefined ? {} : { maxBatches: opts.maxBatches }),
  };

  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  // Never wait longer than the done rows live, or the proof is gone first.
  const deadWaitMs = Math.min(
    opts.resolvedDeadRetentionMs ?? DEFAULT_RESOLVED_DEAD_RETENTION_MS,
    retentionMs,
  );
  const resolvedDead = await pruneResolvedDeadItems(db, {
    ...shared,
    before: new Date(now() - deadWaitMs).toISOString(),
  });
  const done = await pruneDoneItems(db, {
    ...shared,
    before: new Date(now() - retentionMs).toISOString(),
  });
  const cap = await enforceQueueCap(db, {
    ...shared,
    ...(opts.cap === undefined ? {} : { cap: opts.cap }),
  });

  const state: QueuePruneSummary['state'] = cap.overCap
    ? 'failed'
    : done.done && resolvedDead.done
      ? 'ok'
      : 'partial';
  return { done, resolvedDead, cap, state };
}

/**
 * Writes the prune's outcome to sync_run, where the alert sweep already looks.
 *
 * WHY A RUN ROW. The prune failed on 18, 20 and 24 Nov 2026 and nobody was told:
 * a failed Actions run mails at most whoever last edited the cron, and the sweep
 * reads only sync_run and sync_queue. A 'failed' row here is reported by the
 * next sweep like any crashed pass. Written once, at the end, because the run is
 * a minute long - there is no heartbeat to keep.
 *
 * Best effort: if the database is what failed, this fails too, and the non-zero
 * exit (a red Actions run) is the signal that is left.
 */
export async function recordQueuePruneRun(
  db: SupabaseClient,
  run: {
    readonly runId: string;
    readonly kBusiness: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly state: 'ok' | 'partial' | 'failed';
    readonly error: string | null;
  },
): Promise<void> {
  await db.insert('sync_run', [
    {
      run_id: run.runId,
      job_name: QUEUE_PRUNE_JOB,
      k_business: run.kBusiness,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      heartbeat_at: run.finishedAt,
      state: run.state,
      ...(run.error === null ? {} : { error: run.error }),
    },
  ]);
}

function targetKey(i: { work_type: string; target_key: string; k_business: string }): string {
  return `${i.work_type}|${i.target_key}|${i.k_business}`;
}
