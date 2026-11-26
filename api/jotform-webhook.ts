import { waitUntil } from '@vercel/functions';
import { loadConfig } from '../src/config/index.js';
import type { AppConfig } from '../src/config/schema.js';
import { secretMatches } from '../src/http/bearer.js';
import { createLogger } from '../src/logging/logger.js';
import { credentialValues, scrubMessage } from '../src/logging/redact.js';
import { SupabaseClient } from '../src/supabase/client.js';
import {
  missingWebhookSettings,
  processWebhookSubmission,
  type WebhookResult,
  webhookDepsFor,
} from '../src/sync/lesson-signoff-webhook.js';

/**
 * Jotform's webhook for the lesson sign-off form (task 039).
 *
 * Jotform POSTs here on every submission. This route answers AT ONCE and does the
 * work afterwards (Vercel's waitUntil): Jotform's webhook gives up after 5 s,
 * while the signed PDF often reaches Drive later than that. The work itself -
 * store, check, file - is lesson-signoff-webhook.ts; this file is the door.
 *
 * WEB-STANDARD HANDLER, NOT (req, res). Jotform posts multipart/form-data, which
 * Vercel's Node helpers do not parse - req.body comes back empty for it. A
 * `POST(request: Request)` export gets the platform's own Request, and
 * `request.formData()` reads multipart and urlencoded alike. Any method not
 * exported here is answered 405 by the platform.
 *
 * THE KEY IS IN THE URL (`?key=`), compared in constant time. Jotform's webhook
 * cannot send an Authorization header. The key is worth little to a thief: the
 * submission is re-read from the Jotform API by id, so the most a holder of the
 * key can do is make this look again at a real submission. Unset key = locked,
 * and the answer is the same 401 as a wrong key, so the route says nothing about
 * its own setup.
 *
 * Requires: JOTFORM_WEBHOOK_KEY, plus the sign-off detection and filing settings.
 */

/** Jotform submission ids are long decimal numbers. Anything else is refused. */
const SUBMISSION_ID = /^\d{1,30}$/;

export interface WebhookRouteDeps {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly loadConfig: () => Promise<AppConfig>;
  readonly process: (config: AppConfig, submissionId: string) => Promise<WebhookResult>;
  /** Where log lines go; the logger's default (stderr, which Vercel keeps) when absent. */
  readonly write?: (line: string) => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** The submission id from Jotform's body (`submissionID`), or null. */
async function readSubmissionId(request: Request): Promise<string | null> {
  const type = request.headers.get('content-type') ?? '';
  let value: unknown = null;
  try {
    if (type.includes('application/json')) {
      value = ((await request.json()) as Record<string, unknown> | null)?.submissionID;
    } else {
      value = (await request.formData()).get('submissionID');
    }
  } catch {
    return null;
  }
  return typeof value === 'string' && SUBMISSION_ID.test(value.trim()) ? value.trim() : null;
}

export function makeWebhookRoute(deps: WebhookRouteDeps) {
  return async function POST(request: Request): Promise<Response> {
    const key = process.env.JOTFORM_WEBHOOK_KEY;
    if (!secretMatches(new URL(request.url).searchParams.get('key'), key)) {
      return json(401, { error: 'unauthorized' });
    }

    const submissionId = await readSubmissionId(request);
    if (submissionId === null) return json(400, { error: 'no valid submissionID in the body' });

    let config: AppConfig;
    try {
      config = await deps.loadConfig();
    } catch {
      return json(500, { error: 'configuration could not be resolved' });
    }
    const missing = missingWebhookSettings(config);
    if (missing.length > 0) {
      // Key NAMES only, as the sync route reports them. 503: Jotform may retry,
      // and the hourly passes handle the submission once the settings exist.
      return json(503, { error: 'sign-off settings incomplete', missing });
    }

    // Logged by the background work, after the answer: Vercel keeps the function
    // alive for it. The project's logger redacts every credential once, before
    // writing - the webhook key included, which config's list does not know of -
    // and an error message is scrubbed of hosts first.
    const log = createLogger({
      level: config.runtime.logLevel,
      secrets: [...credentialValues(config), ...(key === undefined ? [] : [key])],
      ...(deps.write === undefined ? {} : { write: deps.write }),
    });
    deps.waitUntil(
      deps.process(config, submissionId).then(
        (result) => {
          log.info('jotform_webhook', { submissionId, result });
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : 'unknown error';
          log.error('jotform_webhook_failed', {
            submissionId,
            error: scrubMessage(message, config),
          });
        },
      ),
    );
    return json(200, { ok: true, submissionId });
  };
}

export const POST = makeWebhookRoute({
  waitUntil: (p) => {
    waitUntil(p);
  },
  loadConfig: () => loadConfig(),
  process: (config, submissionId) =>
    processWebhookSubmission(
      webhookDepsFor(config, new SupabaseClient(config.supabase)),
      submissionId,
    ),
});
