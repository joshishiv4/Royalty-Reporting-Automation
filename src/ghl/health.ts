import type { GhlConfig } from '../config/schema.js';
import type { HealthCheckResult, HealthProbeDeps } from '../health/types.js';
import type { AppEnv } from '../secrets/types.js';
import { GhlClient, GhlRequestError } from './client.js';

export interface GhlHealthDeps extends HealthProbeDeps {
  env?: AppEnv;
}

/**
 * Confirms the configured GoHighLevel token authenticates and the location
 * scope is what it claims to be.
 *
 * The cheapest call that proves both is a filtered search that will return
 * nothing - the token has to be valid for the request to even reach the search
 * handler, and a wrong location id comes back as 401/403 (PIT tokens are
 * location-scoped, so a mismatch is an authentication failure, not an empty
 * result). The synthetic email is deliberately unrouteable so nobody's real
 * data is ever surfaced by a health check.
 */
export async function checkGhlAuth(
  ghl: GhlConfig,
  deps: GhlHealthDeps = {},
): Promise<HealthCheckResult> {
  const now = deps.now ?? (() => Date.now());
  const target = 'ghl:contacts-search';
  const startedAt = now();

  const client = new GhlClient(ghl, {
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    now,
  });

  try {
    const result = await client.searchContacts({
      email: 'healthcheck+unrouteable@royalty-sync.invalid',
    });
    return {
      target,
      ok: true,
      detail: `token accepted, ${String(result.contacts.length)} contact(s) matched the probe`,
      httpStatus: result.httpStatus,
      latencyMs: now() - startedAt,
    };
  } catch (cause) {
    const latencyMs = now() - startedAt;
    if (cause instanceof GhlRequestError) {
      return {
        target,
        ok: false,
        detail: cause.message,
        ...(cause.details.httpStatus === null ? {} : { httpStatus: cause.details.httpStatus }),
        latencyMs,
      };
    }
    return {
      target,
      ok: false,
      detail: 'contact-search probe failed for an unknown reason',
      latencyMs,
    };
  }
}
