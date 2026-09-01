import { ConfigValidationError, loadConfig } from '../src/config/index.js';
import { isAuthorizedByAny } from '../src/http/bearer.js';
import { readJsonBody } from '../src/http/body.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';
import { MissingSecretsError, SecretsProviderError } from '../src/secrets/types.js';
import { SupabaseClient } from '../src/supabase/client.js';
import { setWindowOverride } from '../src/sync/job-state.js';
import { findJobGroup, JOB_GROUPS, runJobGroup } from '../src/sync/jobs.js';
import { readSyncProgress } from '../src/sync/progress.js';
import { readWindowRequest } from '../src/sync/visit-window.js';

/**
 * One scheduled job, named by `?job=`.
 *
 * WHY ONE ROUTE AND NOT SIX FILES. Six routes would be six copies of the same
 * auth, the same budget, the same error handling - and the day one of them drifts
 * is the day a job fails differently from its siblings for no reason anybody can
 * see. The job list lives in src/sync/jobs.ts where it can be tested; this is the
 * HTTP edge and nothing else.
 *
 * THE SCHEDULE IS IN vercel.json, six cron entries pointing here. The two
 * overnight ones are ordered deliberately: schedule-window at 01:00, catalogue at
 * 02:00, so sessions reference services that are already current.
 *
 * TWO RUNS OF ONE JOB CANNOT OVERLAP, and that is not enforced here - every pass
 * takes its job's lease (migration 0035) and stands down if another run holds it.
 * Putting the guard in the pass rather than the route means it also covers the
 * CLI, the full sync, and a manual trigger, not just cron.
 *
 * MANUAL TRIGGERING is the same call: POST with `?job=`. Add `{ start, end }` to
 * set the visit window for that run. GET with no `job` lists what can be run.
 *
 * Requires: Authorization: Bearer <SYNC_TRIGGER_TOKEN | CRON_SECRET>
 */

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

/**
 * How long this function may keep STARTING work.
 *
 * Under the platform's own timeout so the run ends by choice - reporting what is
 * left - instead of being killed mid-item with its lease held.
 */
const FUNCTION_BUDGET_MS = 50_000;

/** The job whose window a start/end applies to. Visits are the only windowed pass. */
const WINDOWED_JOB = 'client_session_sync';

function isConfigError(error: unknown): boolean {
  return (
    error instanceof ConfigValidationError ||
    error instanceof MissingSecretsError ||
    error instanceof SecretsProviderError
  );
}

function readJobName(req: HttpRequest): string | null {
  const q = (req as { query?: Record<string, unknown> }).query;
  const raw = q?.job ?? null;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  // Vercel populates req.query, but a bare Node handler may not - fall back to
  // the URL so this route behaves the same under both.
  const url = (req as { url?: string }).url;
  if (typeof url === 'string') {
    const m = /[?&]job=([^&]+)/.exec(url);
    if (m?.[1] !== undefined) return decodeURIComponent(m[1]);
  }
  return null;
}

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

  const name = readJobName(req);
  if (name === null) {
    // No job named: say what there is, rather than guessing one.
    res.status(200).json({
      jobs: JOB_GROUPS.map((g) => ({
        job: g.name,
        summary: g.summary,
        passes: g.passes.map((p) => p.job),
      })),
    });
    return;
  }

  const group = findJobGroup(name);
  if (group === undefined) {
    res.status(404).json({
      error: `unknown job "${name}"`,
      jobs: JOB_GROUPS.map((g) => g.name),
    });
    return;
  }

  // Rejected BEFORE any work starts: a window this cannot parse would reach
  // WellnessLiving matching nothing - accepted, obeyed, and worthless.
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

    const result = await runJobGroup(group, config, { db, budgetMs: FUNCTION_BUDGET_MS });
    const progress = await readSyncProgress(db, config.wl.kBusiness);

    // `failed` is the only 503. `skipped` is a 200: the job is running, just not
    // here, and a scheduler retrying that would only make the overlap worse.
    res.status(result.state === 'failed' ? 503 : 200).json({
      ...result,
      complete: progress.complete,
      remaining: progress.totals,
      window_applied: window.requested ? { start: window.start, end: window.end } : null,
    });
  } catch (error) {
    const safe = isConfigError(error);
    res.status(500).json({
      ok: false,
      error: safe ? 'configuration could not be resolved' : 'the job could not be run',
      // Config errors name the offending KEYS, never their values. Anything else
      // may carry a host in its message, so it is reduced to its class name.
      detail: safe
        ? error instanceof Error
          ? error.message
          : 'unknown error'
        : error instanceof Error
          ? error.name
          : 'unknown error',
    });
  }
}
