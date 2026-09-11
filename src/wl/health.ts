import type { WlConfig } from '../config/schema.js';
import type { HealthCheckResult, HealthProbeDeps } from '../health/types.js';
import type { AppEnv } from '../secrets/types.js';
import { WlAuthError, WlTokenClient } from './token.js';

export interface WlHealthDeps extends HealthProbeDeps {
  /** Named in the failure detail, so a rejection says which pair was used. */
  env?: AppEnv;
}

/**
 * Confirms WellnessLiving issues a token for the configured credentials.
 *
 * This is the cheapest call that proves four things at once: WL_AUTH_HOST is
 * the auth host and not the data host, the credential pair is valid, the pair
 * matches this environment, and the network path is open. It reads no business
 * data, so it is safe to run against production.
 */
export async function checkWlAuth(
  wl: WlConfig,
  deps: WlHealthDeps = {},
): Promise<HealthCheckResult> {
  const now = deps.now ?? (() => Date.now());
  const target = 'wl:oauth2';
  const startedAt = now();

  // A fresh client per probe: a cached token from the running process would
  // make the probe pass without ever contacting WL.
  const client = new WlTokenClient(wl, {
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    now,
  });

  try {
    await client.getAccessToken();
    const expiresInMs = client.status().expiresInMs ?? 0;
    return {
      target,
      ok: true,
      detail: `token issued, valid for ${String(Math.round(expiresInMs / 1000))}s`,
      httpStatus: 200,
      latencyMs: now() - startedAt,
    };
  } catch (cause) {
    const latencyMs = now() - startedAt;
    if (cause instanceof WlAuthError) {
      return {
        target,
        ok: false,
        detail: cause.message,
        ...(cause.httpStatus === undefined ? {} : { httpStatus: cause.httpStatus }),
        latencyMs,
      };
    }
    return { target, ok: false, detail: 'token request failed for an unknown reason', latencyMs };
  }
}
