import type { AppConfig } from '../config/schema.js';
import { checkGhlAuth } from '../ghl/health.js';
import { checkSupabaseReachable } from '../supabase/health.js';
import { checkWlAuth } from '../wl/health.js';
import type { HealthCheckResult, HealthProbeDeps } from './types.js';

export type { HealthCheckResult, HealthProbeDeps } from './types.js';

/**
 * Runs every reachability check the foundation layer owns.
 *
 * Probes run in parallel: they are independent, and a healthcheck that waits
 * for one slow dependency before starting the next reports a latency nobody
 * actually experiences. Neither probe reads business data, so this is safe to
 * run against production.
 */
export async function checkAll(
  config: AppConfig,
  deps: HealthProbeDeps = {},
): Promise<HealthCheckResult[]> {
  const withTimeout: HealthProbeDeps = {
    ...deps,
    timeoutMs: deps.timeoutMs ?? config.runtime.httpTimeoutMs,
  };

  return Promise.all([
    checkSupabaseReachable(config.supabase, withTimeout),
    checkWlAuth(config.wl, { ...withTimeout, env: config.env }),
    checkGhlAuth(config.ghl, { ...withTimeout, env: config.env }),
  ]);
}
