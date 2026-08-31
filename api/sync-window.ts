import { ConfigValidationError, loadConfig } from '../src/config/index.js';
import { isAuthorizedByAny } from '../src/http/bearer.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';
import { MissingSecretsError, SecretsProviderError } from '../src/secrets/types.js';
import { SupabaseClient } from '../src/supabase/client.js';
import { readWindowState, setWindowOverride } from '../src/sync/job-state.js';
import { visitWindow } from '../src/sync/visit-window.js';

/**
 * Reads and sets the visit sync's date window, token-protected.
 *
 * WHY THIS EXISTS. The window is normally derived and needs no operator at all:
 * SYNC_HISTORY_START until a pass drains cleanly, then a rolling overlap of
 * SYNC_DAILY_LOOKBACK_DAYS. That rule is self-correcting - an interrupted
 * backfill leaves the watermark unmoved and so still looks like a backfill - and
 * it is deliberately NOT a stored cursor that advances, because a stored cursor
 * advancing past an interrupted run loses that work silently and forever.
 *
 * But "go and read March 2023 again" is a real need, and the alternatives are all
 * worse: editing a constant and redeploying, or hand-writing a script against the
 * live database. So a ONE-SHOT override sits beside the rule and wins while set.
 *
 * IT IS CONSUMED BY THE NEXT CLEAN DRAIN (0031), not by being read. A run that
 * dies before doing the work must not have swallowed the request. And it clears
 * rather than persists on purpose: a standing override means every nightly run
 * re-fetches the same range at full cost while reporting success.
 *
 *   GET     what the next window will be, and why
 *   POST    { start, end } - set the one-shot window (either may be omitted)
 *   DELETE  clear it
 *
 * AUTH is the same as the sync trigger: `Authorization: Bearer <token>` matched
 * against SYNC_TRIGGER_TOKEN or CRON_SECRET. Both unset means locked, not open.
 */

/** The job whose window this is. Visits are the only windowed pass today. */
const JOB_NAME = 'client_session_sync';

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE']);

function isConfigError(error: unknown): boolean {
  return (
    error instanceof ConfigValidationError ||
    error instanceof MissingSecretsError ||
    error instanceof SecretsProviderError
  );
}

/**
 * Accepts `1980-01-01` or a full ISO timestamp, and refuses anything else.
 *
 * Rejected rather than coerced: a date this endpoint cannot parse would otherwise
 * become `Invalid Date` and reach WellnessLiving as a window that quietly matches
 * nothing - a request accepted, obeyed, and worthless.
 */
function parseBoundary(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string date`);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(ms)) throw new Error(`${field} is not a date this endpoint can read`);
  return new Date(ms).toISOString();
}

function readBody(req: HttpRequest): Record<string, unknown> {
  const raw = (req as { body?: unknown }).body;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('body is not valid JSON');
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  throw new Error('body is not valid JSON');
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
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const config = await loadConfig();
    const db = new SupabaseClient(config.supabase);
    const kBusiness = config.wl.kBusiness;
    const now = new Date();

    if (req.method === 'POST' || req.method === 'DELETE') {
      const body = req.method === 'DELETE' ? {} : readBody(req);
      const start = req.method === 'DELETE' ? null : parseBoundary(body.start, 'start');
      const end = req.method === 'DELETE' ? null : parseBoundary(body.end, 'end');

      if (start !== null && end !== null && Date.parse(start) >= Date.parse(end)) {
        res.status(400).json({ ok: false, error: 'start must be before end' });
        return;
      }
      await setWindowOverride(db, JOB_NAME, kBusiness, start, end, now.toISOString());
    }

    const state = await readWindowState(db, JOB_NAME, kBusiness);
    const next = visitWindow({
      historyStart: config.sync.historyStart,
      lookbackDays: config.sync.dailyLookbackDays,
      lastCleanCompletionAt: state.lastCleanCompletionAt,
      startOverride: state.startOverride,
      endOverride: state.endOverride,
      now: now.getTime(),
    });

    res.status(200).json({
      ok: true,
      job: JOB_NAME,
      // What the next run will actually ask WellnessLiving for.
      next_window: { start: next.dtuStart, end: next.dtuEnd },
      // WHY it is that, so a surprising window explains itself without a code read.
      source: next.isOverride ? 'manual override' : next.isInitial ? 'backfill' : 'daily overlap',
      override: { start: state.startOverride, end: state.endOverride },
      last_clean_completion_at: state.lastCleanCompletionAt,
      history_start: config.sync.historyStart,
      daily_lookback_days: config.sync.dailyLookbackDays,
      note: next.isOverride
        ? 'One shot: the next clean drain consumes this override and reverts to the rule.'
        : undefined,
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
    // A bad request is the caller's to fix and its message is safe - it only ever
    // names a field. Anything else is reduced to its class name, because a raw
    // message can carry a host and a host must not reach a response body.
    const isBadRequest =
      error instanceof Error &&
      (error.message.startsWith('start') ||
        error.message.startsWith('end') ||
        error.message.startsWith('body'));
    if (isBadRequest) {
      res.status(400).json({ ok: false, error: error.message });
      return;
    }
    res.status(500).json({
      ok: false,
      error: 'sync window request failed',
      detail: error instanceof Error ? error.name : 'unknown error',
    });
  }
}
