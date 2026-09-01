import type { SmtpConfig } from '../config/schema.js';
import type { SupabaseClient } from '../supabase/client.js';
import { buildDigest, type DeadItem } from './failure-digest.js';
import { createSmtpClient, nullSmtpClient, type MailResult } from './smtp.js';

/**
 * Reads TERMINAL failures since a cutoff, builds a plain-English digest, and
 * mails it. Never throws. When SMTP is unconfigured, still builds the digest
 * so its verdict can be logged - just does not send.
 *
 * WHAT COUNTS AS TERMINAL. Only failures that will NOT clear themselves on
 * the next run:
 *
 *   - Queue rows in state `dead` - the retry ladder is spent, the item will
 *     not be tried again without a human.
 *   - `sync_run` rows in state `failed` - a whole pass crashed on something
 *     the queue itself could not record as an item state (typically a
 *     Supabase error in the seed, or an uncaught exception).
 *
 * WHAT IS DELIBERATELY EXCLUDED. Partial runs, transient rate-limit hits,
 * transient timeouts, requeued items - all of these will retry on their own
 * on the next invocation. Emailing on those would train the reader to ignore
 * this inbox, which is worse than not sending anything.
 *
 * WHY THE CUTOFF, AND WHY IT IS OPTIONAL. Sending yesterday's dead-letter
 * items every night would be noise: the same records would email the same
 * person for as many nights as they stay dead. Passing `since` scopes the
 * digest to items that DIED in the current run, so a repeat run without new
 * failures sends no mail. Omitting `since` sends every dead item there is,
 * which is the shape the manual "what does the queue look like" report wants.
 */
export interface NotifyOptions {
  /** ISO timestamp. Only failures whose updated_at >= this are included. */
  readonly since?: string;
  /** Which businesses to include; omit to include every one on the DB. */
  readonly kBusiness?: string;
}

export interface NotifyResult {
  readonly deadCount: number;
  /** How many whole passes crashed - separate from dead items. */
  readonly crashedPassCount: number;
  readonly sent: boolean;
  readonly detail?: string;
}

interface FailedRun {
  readonly job_name: string;
  readonly error: string | null;
}

export async function notifyDeadLetter(
  db: SupabaseClient,
  smtp: SmtpConfig,
  opts: NotifyOptions = {},
): Promise<NotifyResult> {
  const filters = ['state=eq.dead'];
  if (opts.since !== undefined) filters.push(`updated_at=gte.${opts.since}`);
  if (opts.kBusiness !== undefined) filters.push(`k_business=eq.${opts.kBusiness}`);

  let deadItems: DeadItem[] = [];
  try {
    // Bounded read - limit=500 is intentional: a digest email past that is
    // unreadable anyway, and the count summary still reflects reality up to
    // the cap. Keeping the limit on the same line as the select call makes
    // the no-unbounded-select structural check see it.
    deadItems = await db.select<DeadItem>(
      'sync_queue',
      `${filters.join('&')}&select=work_type,target_key,last_error,last_error_sid,last_http_status,attempt_count&order=updated_at.desc&limit=500`,
    );
  } catch {
    return {
      deadCount: 0,
      crashedPassCount: 0,
      sent: false,
      detail: 'could not read dead-letter items',
    };
  }

  // Whole-pass crashes: sync_run rows in state=failed since the cutoff. Read
  // separately because they live on a different table and answer a different
  // question (which JOB failed, not which record). If this read fails the
  // dead-letter digest is still sent - one broken read must not silence the
  // other.
  const runFilters = ['state=eq.failed'];
  if (opts.since !== undefined) runFilters.push(`started_at=gte.${opts.since}`);
  if (opts.kBusiness !== undefined) runFilters.push(`k_business=eq.${opts.kBusiness}`);
  let failedRuns: FailedRun[] = [];
  try {
    failedRuns = await db.select<FailedRun>(
      'sync_run',
      `${runFilters.join('&')}&select=job_name,error&order=started_at.desc&limit=50`,
    );
  } catch {
    // fall through with an empty list - dead items are still worth mailing.
  }

  const digest = buildDigest(deadItems, failedRuns);
  if (!digest.hasIssues) {
    return { deadCount: 0, crashedPassCount: 0, sent: false };
  }

  const client = smtp.host === null ? nullSmtpClient() : createSmtpClient(smtp);
  const result: MailResult = await client.send({
    to: smtp.to,
    subject: digest.subject,
    text: digest.body,
  });

  return {
    deadCount: deadItems.length,
    crashedPassCount: failedRuns.length,
    sent: result.ok && smtp.host !== null,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };
}

export { buildDigest, type DeadItem, type DeadDigest } from './failure-digest.js';
export {
  createSmtpClient,
  nullSmtpClient,
  type MailEnvelope,
  type MailResult,
  type SmtpClient,
} from './smtp.js';
