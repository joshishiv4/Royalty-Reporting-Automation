import { loadConfig } from '../src/config/index.js';
import { checkAll } from '../src/health/index.js';
import { isAuthorized, isAuthorizedByAny } from '../src/http/bearer.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';

// Re-exported so existing importers keep working now that the check is shared.
export { isAuthorized };

/**
 * Token-protected health probe, deployed as a Vercel Serverless Function.
 *
 * This is the ONLY thing this repo deploys to Vercel, and deliberately so: a
 * Vercel function is capped at 60s on Hobby, while the daily sync is budgeted at
 * two hours and the backfill at eight (PRD section 12). The sync engine runs
 * elsewhere; this endpoint exists to answer one question from outside the
 * network - "can the deployed environment resolve its config and reach
 * Supabase?" - which is otherwise only checkable from a developer's laptop.
 *
 * Requires: Authorization: Bearer <HEALTHCHECK_TOKEN>
 */

/** Retained names for this route's existing importers. */
export type HealthRequest = HttpRequest;
export type HealthResponse = HttpResponse;

export default async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (
    !isAuthorizedByAny(req.headers.authorization, [
      process.env.SYNC_TRIGGER_TOKEN,
      process.env.HEALTHCHECK_TOKEN,
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
    const results = await checkAll(config);
    const ok = results.every((r) => r.ok);

    res.status(ok ? 200 : 503).json({
      env: config.env,
      secretsProvider: config.secretsProviderName,
      ok,
      results,
    });
  } catch (error) {
    // Config errors name the offending KEYS, never their values - see
    // src/config/schema.ts. Safe to return to an authorized caller.
    res.status(500).json({
      ok: false,
      error: 'configuration could not be resolved',
      detail: error instanceof Error ? error.message : 'unknown error',
    });
  }
}
