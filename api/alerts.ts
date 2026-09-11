import { loadConfig } from '../src/config/index.js';
import { isAuthorizedByAny } from '../src/http/bearer.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';
import { notifyDeadLetter } from '../src/notify/index.js';
import { SupabaseClient } from '../src/supabase/client.js';

/**
 * The alert sweep, on its own schedule and deliberately nothing else's.
 *
 * WHY IT IS NOT PART OF A SYNC. The sync routes already send a digest of what
 * died during their own run, and that covers failures. It cannot cover the
 * failure this endpoint exists for. If the thing that stops running IS the sync,
 * an alert hosted inside the sync never executes - the one check designed to
 * notice that nothing happened is the check that does not happen. Putting it in
 * its own function, on its own cron, is what breaks that circle.
 *
 * WHAT IT REPORTS, AND WHY IT IS SCOPED DIFFERENTLY. The sync's own call passes
 * `since` so it mails about items that died in THAT run and does not re-mail
 * yesterday's news. This one deliberately passes no `since`: it reports STANDING
 * state - jobs overdue against their declared cadence, the parked backlog once
 * it crosses the threshold, and records flagged for review beyond 48 hours.
 * Those are conditions rather than events, and a condition is still true the
 * next time somebody looks.
 *
 * IT STILL SENDS NOTHING WHEN THERE IS NOTHING. `force` is not set here - that
 * belongs to `alert:test` alone. A quiet inbox is the signal that the system is
 * fine, and an alert channel that mails on healthy days stops being read, which
 * is the same silent failure one level up.
 *
 * WHAT THIS STILL CANNOT CATCH. If the deployment itself is gone, paused, or
 * never received these crons, this function does not run either and nobody is
 * told. No internal check can cover that: something outside the platform has to
 * notice the platform. An external uptime monitor against `/api/health` is the
 * other half, and it is not in this repository because it is not code.
 *
 * AUTH: `Authorization: Bearer <token>`, matched against SYNC_TRIGGER_TOKEN or
 * CRON_SECRET. Vercel Cron sends CRON_SECRET automatically. Sending mail is an
 * action, so HEALTHCHECK_TOKEN is deliberately NOT accepted here - a token
 * handed out for polling a status page should not be able to mail anybody.
 */

/** GET because Vercel Cron issues GET; POST for a manual sweep. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

/**
 * How far back the sweep looks for crashed passes.
 *
 * Deliberately WIDER than the six-hour cron interval. Equal to it would mean a
 * crash landing either side of a sweep boundary is reported by neither, and an
 * alert that can miss the thing it is watching for is worse than no alert. The
 * overlap costs a repeat of at most one sweep's worth, which is a fair trade
 * against silence.
 */
const CRASH_WINDOW_MS = 8 * 60 * 60 * 1000;

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
    const db = new SupabaseClient(config.supabase);

    // No `since`: the standing conditions - overdue jobs, the parked backlog,
    // records waiting on a human - are read unbounded because each is still
    // true the next time anybody looks.
    //
    // `crashedSince` is the exception, and it was learned the hard way. A
    // crashed pass is an EVENT, not a condition: the row stays in sync_run for
    // ever, so an unbounded read re-reports the same crash on every sweep. The
    // first live sweep mailed 45 crashes from a loop that had already been
    // stopped, and would have mailed those same 45 every six hours from then
    // on. One window wider than the sweep interval, so a crash cannot fall
    // between two sweeps and go unreported.
    const crashedSince = new Date(Date.now() - CRASH_WINDOW_MS).toISOString();
    const result = await notifyDeadLetter(db, config.smtp, {
      kBusiness: config.wl.kBusiness,
      crashedSince,
    });

    // 200 whether or not anything was sent. "Nothing to report" is the healthy
    // answer to a sweep, not an error - a non-2xx here would have Vercel retry
    // a run that did exactly what it should.
    res.status(200).json({ env: config.env, ...result });
  } catch (error) {
    // A sweep that cannot read the database is itself a signal, and it must be
    // visible as a failed invocation rather than a quiet 200.
    res.status(500).json({
      error: 'alert sweep failed',
      detail: error instanceof Error ? error.message : 'unknown error',
    });
  }
}
