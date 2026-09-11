/**
 * When to try again, and when not to.
 *
 * The rule that shapes this file: a failure is retried only if retrying could
 * plausibly change the answer. A bad parameter will be just as bad in twenty-five
 * minutes, so it fails immediately; a throttle or a timeout is a statement about
 * right now, so it is retried on a widening schedule.
 *
 * TWO LADDERS, because there are two different waits:
 *
 *   - IN-PROCESS (seconds). A run that gets throttled should still finish, so the
 *     client sleeps briefly and tries again inside the same pass. The whole
 *     ladder fits inside the step budget, which a minutes-long wait never could:
 *     a Vercel function is capped at 60s.
 *   - REQUEUE (minutes). When the in-process ladder is exhausted, the item is
 *     handed back for a later attempt on the 1 / 5 / 25 minute schedule. The
 *     queue and worker layer (PRD M03) performs the wait; this module only says
 *     how long it should be.
 *
 * Both ladders are 1 : 5 : 25. Same shape, different unit.
 *
 * JITTER exists because every worker throttled by the same burst would otherwise
 * wake at the same instant and reproduce the burst that caused the throttle. The
 * jitter is added on top of the base, never subtracted, so the documented
 * schedule is the floor rather than an average.
 */

/** Requeue delays: 1 minute, 5 minutes, 25 minutes. */
export const RETRY_SCHEDULE_MS: readonly number[] = [60_000, 300_000, 1_500_000];

/** In-process throttle backoff: 1s, 5s, 25s. Sums to 31s, inside the step budget. */
export const THROTTLE_BACKOFF_MS: readonly number[] = [1_000, 5_000, 25_000];

/**
 * Longest WL `Retry-After` we honour by sleeping IN-PROCESS. A longer one is
 * requeued with that exact delay instead: sleeping minutes inside a 60s function
 * is how a reportable requeue becomes a silent timeout. Matches the ladder's own
 * ceiling - we wait in-process at most as long as our own backoff ever would.
 */
export const MAX_IN_PROCESS_RETRY_AFTER_MS = 25_000;

/** How much jitter is added, as a fraction of the base delay. */
export const JITTER_FRACTION = 0.2;

/**
 * `base` plus up to 20% more.
 *
 * Added, not centred: the acceptance criterion names a 1/5/25 minute schedule,
 * and a reader checking that should see 60_000 as the smallest possible first
 * delay, not 54_000.
 */
export function jittered(baseMs: number, random: () => number = Math.random): number {
  const spread = baseMs * JITTER_FRACTION;
  return Math.round(baseMs + random() * spread);
}

/**
 * Delay before requeue attempt number `attempt` (0-based), or null when the
 * schedule is exhausted and the item belongs in the dead-letter table.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number | null {
  const base = RETRY_SCHEDULE_MS[attempt];
  return base === undefined ? null : jittered(base, random);
}

/**
 * Delay before in-process throttle attempt `attempt` (0-based), or null when the
 * client should stop trying and hand the item back for requeue.
 */
export function throttleBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number | null {
  const base = THROTTLE_BACKOFF_MS[attempt];
  return base === undefined ? null : jittered(base, random);
}

/**
 * WL's own instruction, when it sends one.
 *
 * `Retry-After` is either seconds or an HTTP date. A server that says how long to
 * wait outranks any ladder we invented, so this is preferred when present and
 * sane. The caller decides whether to sleep it in-process or requeue with it (see
 * MAX_IN_PROCESS_RETRY_AFTER_MS); this only rejects the absurd. The ceiling is one
 * hour: a real throttle asks for seconds or minutes, so anything longer is a bad
 * header, not an instruction to stall a run for a day.
 */
export function parseRetryAfter(
  header: string | null,
  now: number,
  maxMs = 3_600_000,
): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    const ms = seconds * 1000;
    return ms >= 0 && ms <= maxMs ? Math.round(ms) : null;
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const ms = at - now;
  return ms >= 0 && ms <= maxMs ? Math.round(ms) : null;
}
