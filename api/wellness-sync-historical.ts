import { ConfigValidationError, loadConfig } from '../src/config/index.js';
import { isAuthorizedByAny } from '../src/http/bearer.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';
import { MissingSecretsError, SecretsProviderError } from '../src/secrets/types.js';
import { readJsonBody } from '../src/http/body.js';
import { setWindowOverride } from '../src/sync/job-state.js';
import { runHistoricalScheduleSyncPass } from '../src/sync/pass.js';
import { readWindowRequest } from '../src/sync/visit-window.js';
import { SupabaseClient } from '../src/supabase/client.js';

/**
 * Token-protected HISTORICAL class-schedule sync, deployed as a Vercel function.
 *
 * WHY THIS IS ITS OWN ENDPOINT AND NOT PART OF /api/wellness-sync-all. The daily
 * full sync covers the rolling -7 / +30 day window every night. The historical
 * loop cuts a REQUESTED date range into calendar-month chunks and pulls each
 * one as its own queue item, so a killed run resumes on the same month rather
 * than restarting the range. Those are two different shapes: one is a nightly
 * cadence bounded by wall clock, the other is a deliberate backfill bounded by
 * how far back the studio asked to load.
 *
 * WHAT THE CRON DOES WITH NO PENDING ASK. It re-reads the last
 * SYNC_MONTHLY_LOOKBACK_MONTHS calendar months (default 2) rather than exiting.
 * Firing on the 1st, that is the whole of the month just finished - so every
 * month is re-checked once, shortly after it ends, and a session edited
 * retroactively outside the daily windows is still caught. Setting the config
 * to 0 restores the old behaviour of doing nothing unless asked.
 *
 * An explicit ask still wins: an override set via a POST here (or the CLI) is
 * honoured exactly as given and cleared on the clean drain, so a deliberate
 * backfill is never widened or narrowed by the cadence.
 *
 * WHY POST ACCEPTS A start/end BODY. Setting a window is the whole point of
 * asking this endpoint anything; making it a one-call flow means a caller
 * never leaves an override sitting there for the next cron to obey by
 * surprise. GET (which Vercel Cron uses) never sets a window - the schedule
 * drains whatever the last human ask put there.
 *
 * AUTH: `Authorization: Bearer <token>`, matched against SYNC_TRIGGER_TOKEN or
 * CRON_SECRET. Both unset means the endpoint is locked, not open - the same
 * rule the daily endpoint follows.
 */

function isConfigError(error: unknown): boolean {
  return (
    error instanceof ConfigValidationError ||
    error instanceof MissingSecretsError ||
    error instanceof SecretsProviderError
  );
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

/** How long this function may keep STARTING work, kept under the platform cap. */
const FUNCTION_BUDGET_MS = 50_000;

/** The one job this endpoint owns - kept as a constant so the string never drifts. */
const HISTORICAL_JOB = 'historical_schedule_sync';

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
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  let window: { start: string | null; end: string | null; requested: boolean };
  try {
    window = readWindowRequest(readJsonBody(req));
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'window could not be read',
    });
    return;
  }

  try {
    const config = await loadConfig();
    const db = new SupabaseClient(config.supabase);

    // Setting a window is deliberate on this endpoint - it targets the
    // historical job, not the daily one. A cron invocation sends no body and
    // simply drains whatever the last human ask left behind.
    if (window.requested) {
      await setWindowOverride(
        db,
        HISTORICAL_JOB,
        config.wl.kBusiness,
        window.start,
        window.end,
        new Date().toISOString(),
      );
    }

    const summary = await runHistoricalScheduleSyncPass(config, { budgetMs: FUNCTION_BUDGET_MS });

    res.status(summary.state === 'failed' ? 503 : 200).json({
      ...summary,
      window_applied: window.requested ? { start: window.start, end: window.end } : null,
    });
  } catch (error) {
    if (isConfigError(error)) {
      res.status(500).json({
        ok: false,
        error: 'configuration could not be resolved',
        detail: (error as Error).message,
      });
      return;
    }
    res.status(500).json({
      ok: false,
      error: 'sync failed unexpectedly',
      detail: error instanceof Error ? error.name : 'unknown error',
    });
  }
}
