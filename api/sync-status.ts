import { loadConfig } from '../src/config/index.js';
import { isAuthorizedByAny } from '../src/http/bearer.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';
import { SupabaseClient } from '../src/supabase/client.js';
import { readSyncProgress } from '../src/sync/progress.js';

/**
 * How far the sync has got - built to be POLLED.
 *
 * WHY THIS IS A SEPARATE ENDPOINT. A sync invocation can only report what IT
 * did, and on a serverless function that is at most one budget's worth. Nothing
 * can both start a long backfill and return its outcome in the same response:
 * the platform kills the function the moment it answers. So the work and the
 * question about the work are two endpoints, and the durable queue is what joins
 * them.
 *
 * That split is not a workaround, it is the thing the queue was for. This reads
 * state that is true no matter which process is working, or whether any process
 * is - which is precisely what a run summary cannot tell you. On live dev 31 Aug
 * 2026, 40,333 items sat queued for days while every individual run returned
 * `ok`, because each run honestly described its own fifty seconds and nobody was
 * asking the queue.
 *
 * ALWAYS FAST. Three view/index reads, none of which grows with the queue, so a
 * client may poll every few seconds. It never starts work and never writes, so
 * polling it cannot interfere with a running sync.
 *
 * Requires: Authorization: Bearer <HEALTHCHECK_TOKEN>
 */

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

export default async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
  // Progress that is one poll stale is worse than useless - it reads as a
  // stalled sync.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== undefined && !ALLOWED_METHODS.has(req.method)) {
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
    const db = new SupabaseClient(config.supabase);
    const progress = await readSyncProgress(db, config.wl.kBusiness);

    // 200 whether or not it is finished: "not done yet" is the expected answer
    // to a poll, not an error. A caller stops when `complete` is true.
    res.status(200).json({ env: config.env, ...progress });
  } catch (error) {
    res.status(500).json({
      error: 'progress could not be read',
      detail: error instanceof Error ? error.message : 'unknown error',
    });
  }
}
