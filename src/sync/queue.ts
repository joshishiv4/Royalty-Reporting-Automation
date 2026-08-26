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
 * Adds work, skipping targets that already have an active item.
 *
 * The partial unique index (work_type, target_key, k_business WHERE active) is the
 * real backstop; this pre-filter keeps a normal enqueue from tripping it.
 */
export async function enqueue(
  db: SupabaseClient,
  items: ReadonlyArray<{ work_type: string; target_key: string; k_business: string }>,
  nextAttemptAt?: string,
): Promise<number> {
  if (items.length === 0) return 0;
  // ponytail: selects all active targets; scope by work_type if the queue grows.
  const active = await db.select<{ work_type: string; target_key: string; k_business: string }>(
    'sync_queue',
    'state=in.(pending,in_progress)&select=work_type,target_key,k_business',
  );
  const seen = new Set(active.map(targetKey));
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
