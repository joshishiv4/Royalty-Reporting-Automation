/**
 * When to try a GoHighLevel call again, and when not to.
 *
 * The rule is the same one the WL client follows: a failure is retried only if
 * retrying could plausibly change the answer. A 400 is just as bad in twenty-five
 * seconds; a 429 or a 5xx is a statement about right now.
 *
 * Shape mirrors src/wl/retry.ts on purpose - one ladder to reason about, whether
 * the failing call went to WellnessLiving or GoHighLevel. GHL publishes a rate
 * limit (100 requests per 10 seconds per location, per the developer docs), but
 * the matcher runs once per client and never again, so the total call volume is
 * roughly the client count. A preemptive limiter would be overhead for traffic
 * that never approaches the limit; the reactive ladder handles the incidental
 * 429 without one.
 *
 * JITTER is added on top of the base, never subtracted, so the documented
 * schedule is the floor rather than an average. Same 20% as the WL ladder.
 */

/** In-process throttle backoff: 1s, 5s, 25s. Sums to 31s, inside the step budget. */
export const THROTTLE_BACKOFF_MS: readonly number[] = [1_000, 5_000, 25_000];

/**
 * Longest GHL `Retry-After` we honour by sleeping IN-PROCESS. A longer one is
 * surfaced as a permanent failure with the requested delay recorded, so a queue
 * layer (PRD M03) can schedule the next attempt without a serverless function
 * sleeping for minutes inside a 60s cap.
 */
export const MAX_IN_PROCESS_RETRY_AFTER_MS = 25_000;

/** How much jitter is added, as a fraction of the base delay. */
export const JITTER_FRACTION = 0.2;

export function jittered(baseMs: number, random: () => number = Math.random): number {
  const spread = baseMs * JITTER_FRACTION;
  return Math.round(baseMs + random() * spread);
}

/**
 * Delay before in-process throttle attempt `attempt` (0-based), or null when
 * the client should stop trying and surface the failure.
 */
export function throttleBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number | null {
  const base = THROTTLE_BACKOFF_MS[attempt];
  return base === undefined ? null : jittered(base, random);
}

/**
 * Reads a `Retry-After` header the way HTTP defines it: either seconds or an
 * HTTP date. A server that says how long to wait outranks any ladder we
 * invented. The one-hour ceiling rejects the absurd - a real throttle asks
 * for seconds or minutes; a header longer than that is a bug, not an
 * instruction to stall a run for a day.
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
