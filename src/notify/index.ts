import type { SmtpConfig } from '../config/schema.js';
import type { SupabaseClient } from '../supabase/client.js';
import { buildDigest, type DeadItem, type ReviewEntry } from './failure-digest.js';
import { findOverdueJobs } from './overdue.js';
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
  /**
   * ISO timestamp bounding the CRASHED-PASS read alone.
   *
   * WHY THIS IS SEPARATE FROM `since`. The three other things this digest
   * reports are CONDITIONS - a job overdue against its cadence, a parked
   * backlog, a record waiting on a human - and a condition is still true the
   * next time anybody looks, so the standing sweep reads them unbounded on
   * purpose. A crashed pass is not a condition. It is an EVENT, and an event
   * that happened once stays in sync_run for ever.
   *
   * Reading it unbounded is what the first sweep actually did, and it mailed
   * 45 crashes from a loop that had already been stopped - the same 45 it would
   * have re-mailed every six hours from then on. That is precisely the habit
   * this digest is built to avoid: an inbox that repeats yesterday's news stops
   * being read, and then the one alert that matters arrives into a channel
   * nobody opens.
   *
   * Falls back to `since`, so a caller that scopes everything the same way -
   * the sync's own post-run digest - needs no second argument.
   */
  readonly crashedSince?: string;
  /** Which businesses to include; omit to include every one on the DB. */
  readonly kBusiness?: string;
  /**
   * Send even when there is nothing to report.
   *
   * Only `alert:test` sets this. A healthy run must never mail anybody - that
   * is what keeps the inbox worth reading - but a test that only works while
   * something is broken cannot be run on demand, which defeats the point of
   * having one.
   */
  readonly force?: boolean;
}

export interface NotifyResult {
  readonly deadCount: number;
  /** How many whole passes crashed - separate from dead items. */
  readonly crashedPassCount: number;
  /** Jobs that should have run and did not. See notify/overdue.ts. */
  readonly overdueCount: number;
  /** Records a human has to look at, summed across issue types. */
  readonly reviewCount: number;
  /** Everything currently parked, not just what died on this run. */
  readonly parkedTotal: number;
  readonly sent: boolean;
  readonly detail?: string;
}

/**
 * The data_health issues that mean "a person has to decide this".
 *
 * Deliberately NOT every issue in the view. `unreviewed_session` sits at 39,104
 * and is the studio's own housekeeping, not a sync problem - mailing it nightly
 * would bury the four rows that actually need somebody. Stale-record issues are
 * excluded for the same reason: they clear themselves on the next run.
 */
const REVIEW_ISSUES = [
  'ghl_unresolved_48h',
  'ambiguous_contact',
  'failed_contact_match',
  'open_conflict',
] as const;

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
      overdueCount: 0,
      reviewCount: 0,
      parkedTotal: 0,
      detail: 'could not read dead-letter items',
    };
  }

  // Whole-pass crashes: sync_run rows in state=failed since the cutoff. Read
  // separately because they live on a different table and answer a different
  // question (which JOB failed, not which record). If this read fails the
  // dead-letter digest is still sent - one broken read must not silence the
  // other.
  const runFilters = ['state=eq.failed'];
  // crashedSince first: a crash is an event, so the standing sweep bounds it
  // even though it reads every other condition unbounded. See NotifyOptions.
  const crashedFrom = opts.crashedSince ?? opts.since;
  if (crashedFrom !== undefined) runFilters.push(`started_at=gte.${crashedFrom}`);
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

  // JOBS THAT NEVER STARTED. Read even when nothing failed - that is the whole
  // point: a job that does not run produces no dead item and no failed run, so
  // every other source above is silent about it.
  let overdue: Awaited<ReturnType<typeof findOverdueJobs>> = [];
  if (opts.kBusiness !== undefined) {
    try {
      overdue = await findOverdueJobs(db, opts.kBusiness);
    } catch {
      // A read that fails says nothing about the jobs. Reporting them overdue
      // would be inventing an alert out of our own outage.
    }
  }

  // Records parked for a human, and the standing parked total. Both answer
  // "what is sitting there", which the per-run dead list cannot.
  let review: ReviewEntry[] = [];
  try {
    const rows = await db.select<{ issue: string; issue_count: number; oldest: string | null }>(
      'data_health',
      `issue=in.(${REVIEW_ISSUES.join(',')})&select=issue,issue_count,oldest&limit=50`,
    );
    review = rows
      .filter((r) => r.issue_count > 0)
      .map((r) => ({ issue: r.issue, count: r.issue_count, oldest: r.oldest }));
  } catch {
    // fall through - the rest of the digest is still worth sending.
  }

  let parkedTotal = 0;
  try {
    const all = await db.select<{ id: string }>('sync_queue', `state=eq.dead&select=id&limit=1000`);
    parkedTotal = all.length;
  } catch {
    // fall through.
  }

  const digest = buildDigest(deadItems, failedRuns, {
    overdue: overdue.map((o) => ({
      job: o.job,
      expectedEveryHours: o.expectedEveryHours,
      hoursSince: o.hoursSince,
    })),
    review,
    parkedTotal,
  });
  const counts = {
    deadCount: deadItems.length,
    crashedPassCount: failedRuns.length,
    overdueCount: overdue.length,
    reviewCount: review.reduce((n, r) => n + r.count, 0),
    parkedTotal,
  };
  if (!digest.hasIssues && opts.force !== true) {
    return { ...counts, sent: false };
  }

  const client = smtp.host === null ? nullSmtpClient() : createSmtpClient(smtp);
  const result: MailResult = await client.send({
    to: smtp.to,
    subject: digest.hasIssues ? digest.subject : 'Royalty sync: alert test, nothing is wrong',
    text: digest.hasIssues
      ? digest.body
      : [
          'This is a test of the royalty sync alert channel.',
          '',
          'Nothing is wrong. Every check came back clean: no failed runs, no jobs ' +
            'overdue, nothing parked, and nothing waiting on a human.',
          '',
          'If you are reading this, alerts reach you.',
        ].join('\n'),
  });

  return {
    ...counts,
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
