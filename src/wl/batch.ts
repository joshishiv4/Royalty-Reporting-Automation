/**
 * Batch processing for the many-small-calls shape.
 *
 * The measured problem (UAT, 19 Aug 2026): enriching 20 staff with their
 * `/v1/user` record took 21 calls and 14.6s run sequentially. The full client
 * base is larger, and a Vercel function is capped at 60s, so "loop and await"
 * stops working well before the real data size.
 *
 * THREE THINGS THIS FIXES, in order of how much they matter:
 *
 *   1. CONCURRENCY. A pull-based worker pool, not fixed chunks. A chunk waits
 *      for its own slowest item before the next chunk starts, so one slow call
 *      idles everything behind it - head-of-line blocking. Workers that pull
 *      the next index as soon as they are free never idle.
 *
 *      The pool bounds how many items are IN FLIGHT. It is deliberately NOT a
 *      request rate: WL publishes no rate limit, so this service does not invent
 *      one - it reacts to what WL actually says. See src/wl/retry.ts for the
 *      throttle backoff that does the reacting.
 *
 *   2. THE TIME BUDGET. Checked before an item is STARTED, never mid-flight.
 *      Abandoning a call that is already out leaves WL doing work nobody reads.
 *      Items never started come back in `remaining`, so the caller can resume
 *      with exactly those.
 *
 *   3. FAILURE ISOLATION. One bad item must not lose the other nineteen. Each
 *      failure is captured against its item and the batch keeps going, which is
 *      also what lets the caller dead-letter individual items later.
 *
 * NEVER SILENTLY TRUNCATES. `remaining` is always returned and is the caller's
 * problem to notice. A result that looks complete when it is not is worse than
 * one that says it ran out of time.
 *
 * RESULTS KEEP INPUT ORDER even though completion order is arbitrary, so output
 * does not change run to run.
 */

export interface BatchFailure<T> {
  readonly item: T;
  /** Position in the input, so a caller can line failures up with its own data. */
  readonly index: number;
  readonly error: unknown;
}

export interface BatchOutcome<T, R> {
  /** Successful results, in input order. */
  readonly results: readonly R[];
  readonly failures: readonly BatchFailure<T>[];
  /** Items never STARTED because the budget ran out. Resume with these. */
  readonly remaining: readonly T[];
  /** How many items were started. `attempted = results + failures`. */
  readonly attempted: number;
  readonly durationMs: number;
  /** True when the budget stopped the run early. Then `remaining` is non-empty. */
  readonly budgetExhausted: boolean;
}

export interface BatchOptions {
  /**
   * Items in flight at once. Defaults to 5, matching the conservative WL
   * starting point. The rate limiter remains the real cap on request rate.
   */
  concurrency?: number;
  /** Stop STARTING new items once this many ms have passed. */
  budgetMs?: number;
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
  /**
   * When the clock started, for a caller that already spent part of its budget
   * before reaching the batch. Defaults to `now()` at entry.
   */
  startedAt?: number;
}

const DEFAULT_CONCURRENCY = 5;

/**
 * Runs `handler` over `items`, concurrently, inside a time budget.
 *
 * `handler` receives the item and its index. It must not throw for control
 * flow - a throw is recorded as that item's failure and the batch continues.
 */
export async function runBatch<T, R>(
  items: readonly T[],
  handler: (item: T, index: number) => Promise<R>,
  options: BatchOptions = {},
): Promise<BatchOutcome<T, R>> {
  const now = options.now ?? (() => Date.now());
  const startedAt = options.startedAt ?? now();
  const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY));

  // Sparse until filled, then compacted - this is what preserves input order
  // while letting items finish in any order.
  const slots = new Array<{ ok: true; value: R } | { ok: false; error: unknown } | undefined>(
    items.length,
  );

  /**
   * Shared cursor. Every worker takes the next index from here, so no index is
   * handled twice and no worker sits idle while work remains.
   */
  let cursor = 0;
  let budgetExhausted = false;
  const startedIndexes = new Set<number>();

  const worker = async (): Promise<void> => {
    for (;;) {
      // Budget is checked HERE, before taking work - never against an item
      // already in flight.
      if (now() - startedAt >= budgetMs) {
        budgetExhausted = true;
        return;
      }
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;

      const item = items[index];
      if (item === undefined) continue;
      startedIndexes.add(index);

      try {
        slots[index] = { ok: true, value: await handler(item, index) };
      } catch (error) {
        // Isolated: nineteen good items must not be lost to one bad one.
        slots[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker()),
  );

  const results: R[] = [];
  const failures: BatchFailure<T>[] = [];
  const remaining: T[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const slot = slots[index];
    const item = items[index];
    if (slot === undefined) {
      // Never started. Only reachable when the budget cut the run short.
      if (item !== undefined) remaining.push(item);
      continue;
    }
    if (slot.ok) results.push(slot.value);
    else if (item !== undefined) failures.push({ item, index, error: slot.error });
  }

  return {
    results,
    failures,
    remaining,
    attempted: startedIndexes.size,
    durationMs: now() - startedAt,
    budgetExhausted: budgetExhausted && remaining.length > 0,
  };
}
