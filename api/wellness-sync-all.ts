import { ConfigValidationError, loadConfig } from '../src/config/index.js';
import { isAuthorizedByAny } from '../src/http/bearer.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';
import { MissingSecretsError, SecretsProviderError } from '../src/secrets/types.js';
import { readJsonBody } from '../src/http/body.js';
import { setWindowOverride } from '../src/sync/job-state.js';
import { runFullSyncPass } from '../src/sync/pass.js';
import { readSyncProgress } from '../src/sync/progress.js';
import { readWindowRequest } from '../src/sync/visit-window.js';
import { SupabaseClient } from '../src/supabase/client.js';

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

/**
 * How long this function may keep STARTING work.
 *
 * Under the platform's own timeout, so the run ends by choice - reporting
 * `partial` with the queue intact - instead of being killed mid-item.
 */
const FUNCTION_BUDGET_MS = 50_000;

/**
 * The job a start/end applies to. Visits are the only windowed pass - every
 * other pass reads all of what it syncs - so a dated request means this one.
 */
const WINDOWED_JOB = 'client_session_sync';

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

  // A start/end in the body sets the visit window for THIS run, so triggering a
  // dated backfill is one call instead of two. Two was a footgun: setting the
  // window and forgetting to run left the override sitting there for whichever
  // cron fired next, which then quietly re-read a range nobody asked it for.
  //
  // Rejected BEFORE any work starts. A window this cannot parse would reach
  // WellnessLiving matching nothing - accepted, obeyed, and worthless - so a bad
  // date must fail the request rather than silently produce an empty sync.
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

    // Set before the run, so the pass that follows picks it up. Only when asked:
    // a cron sends no body and must keep the derived rule (SYNC_HISTORY_START
    // until a clean drain, then a rolling SYNC_DAILY_LOOKBACK_DAYS overlap).
    if (window.requested) {
      await setWindowOverride(
        db,
        WINDOWED_JOB,
        config.wl.kBusiness,
        window.start,
        window.end,
        new Date().toISOString(),
      );
    }
    // The budget lives HERE, not in runFullSyncPass, because it is this
    // caller's constraint and nobody else's: the platform kills the function at
    // its own limit, so the run must stop STARTING work before that and hand
    // back `partial` rather than being killed mid-item with its leases held.
    // A CLI backfill has no such ceiling and must not inherit this one.
    const summary = await runFullSyncPass(config, { budgetMs: FUNCTION_BUDGET_MS });

    // HOW MUCH IS LEFT, in the same response. A run summary describes only what
    // THIS invocation managed, which is at most one budget's worth - so on its
    // own it cannot tell a caller whether to invoke again. Reading the queue
    // afterwards answers that directly, and it is three cheap view reads.
    const progress = await readSyncProgress(db, config.wl.kBusiness);

    // `failed` is the only 503: a pass hit a bug it could not record as queue
    // state. `ok` and `partial` are both 200 - `partial` means the budget ran out
    // with work still queued or a later pass not yet reached, which is the normal
    // way a long run ends and resumes on the next invocation.
    res.status(summary.state === 'failed' ? 503 : 200).json({
      ...summary,
      // `complete` is the flag a scheduler should loop on - not summary.state,
      // which says `ok` for a run that did fifty honest seconds of a two-hour
      // backfill. Poll /api/sync-status for the same answer without working.
      complete: progress.complete,
      // Echoed so a caller can see the dates were understood as intended, rather
      // than discovering later that a typo produced an empty range.
      window_applied: window.requested ? { start: window.start, end: window.end } : null,
      remaining: progress.totals,
      stages: progress.stages,
    });
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
