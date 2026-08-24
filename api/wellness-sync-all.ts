import { ConfigValidationError, loadConfig } from '../src/config/index.js';
import { isAuthorizedByAny } from '../src/http/bearer.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';
import { MissingSecretsError, SecretsProviderError } from '../src/secrets/types.js';
import { runFullSyncPass } from '../src/sync/pass.js';

/**
 * A config-resolution failure whose message is safe to return: these name the
 * offending KEYS, never their values, and carry no host - see src/config.
 * Anything else may carry a host in its message (an undici connect error names
 * it), so it is reduced to its class name before it can reach the wire.
 */
function isConfigError(error: unknown): boolean {
  return (
    error instanceof ConfigValidationError ||
    error instanceof MissingSecretsError ||
    error instanceof SecretsProviderError
  );
}

/**
 * Token-protected FULL WellnessLiving sync, deployed as a Vercel function.
 *
 * This is the endpoint the daily cron calls for a whole WL -> Supabase pull. It
 * runs every pass in dependency order on ONE token and ONE database:
 * staff -> locations -> shop categories -> promotions -> service categories ->
 * purchases -> receipts -> services (see runFullSyncPass). The single-pass
 * `/api/wellness-sync` endpoint stays for
 * a targeted staff-only run; this one is the full pipeline.
 *
 * BOUNDED like a single pass. A Vercel function is capped at 60s while a full
 * sync is budgeted in hours, so the global budget is split across the passes and
 * whatever is not reached comes back `ran: false` for the next invocation to
 * pick up. `partial` therefore means "more work is queued", the normal way a long
 * run ends - it is 200, not an error a cron should alert on. Only `failed` (a bug
 * a pass could not record as queue state) is 503.
 *
 * AUTH: `Authorization: Bearer <token>`, matched against SYNC_TRIGGER_TOKEN or
 * CRON_SECRET. Vercel Cron sends CRON_SECRET as the bearer automatically, so
 * setting that one variable is enough to let the schedule in and keep everyone
 * else out. Both unset means the endpoint is locked, not open.
 */

/** Accepts GET because Vercel Cron issues GET; POST for a manual trigger. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

export default async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== undefined && !ALLOWED_METHODS.has(req.method)) {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (
    !isAuthorizedByAny(req.headers.authorization, [
      process.env.SYNC_TRIGGER_TOKEN,
      process.env.CRON_SECRET,
    ])
  ) {
    // Identical response whether the token is wrong or unconfigured, so the
    // endpoint reveals nothing about its own setup.
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const config = await loadConfig();
    const summary = await runFullSyncPass(config);

    // `failed` is the only 503: a pass hit a bug it could not record as queue
    // state. `ok` and `partial` are both 200 - `partial` means the budget ran out
    // with work still queued or a later pass not yet reached, which is the normal
    // way a long run ends and resumes on the next invocation.
    res.status(summary.state === 'failed' ? 503 : 200).json(summary);
  } catch (error) {
    if (isConfigError(error)) {
      // Names the offending keys, never their values - safe for an authorized
      // caller, and the actionable message is the point.
      res.status(500).json({
        ok: false,
        error: 'configuration could not be resolved',
        detail: (error as Error).message,
      });
      return;
    }
    // Anything else is reduced to its class name. The raw message can carry a
    // host, which is configuration and must not reach a response body - the same
    // rule the WL client follows, enforced here at the last boundary before the
    // wire, where the source-scanning host test cannot reach.
    res.status(500).json({
      ok: false,
      error: 'sync failed unexpectedly',
      detail: error instanceof Error ? error.name : 'unknown error',
    });
  }
}
