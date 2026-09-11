/**
 * Shapes shared by every reachability probe.
 *
 * Kept in their own module so a probe for one dependency (WellnessLiving) does
 * not have to import from another (Supabase) merely to name its return type.
 */

export interface HealthCheckResult {
  /** What was probed, in words safe to print. */
  readonly target: string;
  readonly ok: boolean;
  /** Human-readable outcome. Never contains a credential or a host. */
  readonly detail: string;
  readonly httpStatus?: number;
  readonly latencyMs: number;
}

export interface HealthProbeDeps {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
}
