import type { SupabaseClient } from '../supabase/client.js';
import type { SyncPassSummary } from './pass.js';

/**
 * The per-job lifecycle row in `sync_job_state`.
 *
 * The queue resumes work BETWEEN items; this records the job as a whole - is it
 * running, paused mid-budget, or last finished cleanly - keyed by (job_name,
 * k_business). Its one load-bearing field is `last_clean_completion_at`, the
 * watermark a future incremental sync will trust: it moves ONLY when a pass drains
 * with nothing outstanding. A half-done run must not move it, or the next run skips
 * whatever it missed (the rule the 0007 schema spells out).
 *
 * THE REPORT CURSOR (report_handle, report_page, report_handle_expires_at) is
 * written by the helpers below, and ONLY by the client-list report - the one job
 * that waits on an asynchronous WellnessLiving report. report_handle non-null means
 * "a build has been requested; poll it, do not restart"; report_page is the poll
 * attempt (it picks the backoff delay); report_handle_expires_at is the hard
 * deadline past which the build is abandoned and restarted. Every upsert sends only
 * the columns it sets, so these never clobber the lifecycle fields above.
 */

/** Marks a job running at the start of a pass. */
export async function openJobState(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  now: string,
): Promise<void> {
  await db.upsert(
    'sync_job_state',
    [{ job_name: jobName, k_business: kBusiness, state: 'running', last_seen_at: now }],
    { onConflict: 'job_name,k_business' },
  );
}

/**
 * Closes a job's row with the pass verdict, moving the clean-completion watermark
 * only on a clean drain.
 *
 *   ok      -> idle,   watermark = now
 *   partial -> paused, watermark UNCHANGED (budget stopped it; more is outstanding)
 *   failed  -> failed, watermark UNCHANGED
 */
export async function closeJobState(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  now: string,
  passState: SyncPassSummary['state'],
): Promise<void> {
  const state = passState === 'ok' ? 'idle' : passState === 'partial' ? 'paused' : 'failed';
  await db.upsert(
    'sync_job_state',
    [
      {
        job_name: jobName,
        k_business: kBusiness,
        state,
        last_seen_at: now,
        // Only a clean drain advances the watermark. Omitted otherwise, so an
        // earlier clean completion survives a later partial/failed run.
        ...(passState === 'ok' ? { last_clean_completion_at: now } : {}),
      },
    ],
    { onConflict: 'job_name,k_business' },
  );
}

/** The persisted state of an async report build, for the client-list poller. */
export interface ReportState {
  /** Non-null once a build has been requested: poll it, do not restart. */
  readonly handle: string | null;
  /** Poll attempt so far - selects the backoff delay. */
  readonly pollAttempt: number;
  /** Hard deadline; past it the build is abandoned and restarted. */
  readonly expiresAt: string | null;
}

/** Reads the report cursor. Absent row or null handle both mean "not requested". */
export async function readReportState(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
): Promise<ReportState> {
  const rows = await db.select<{
    report_handle: string | null;
    report_page: number | null;
    report_handle_expires_at: string | null;
  }>(
    'sync_job_state',
    `job_name=eq.${jobName}&k_business=eq.${kBusiness}` +
      `&select=report_handle,report_page,report_handle_expires_at&limit=1`,
  );
  const row = rows[0];
  return {
    handle: row?.report_handle ?? null,
    pollAttempt: row?.report_page ?? 0,
    expiresAt: row?.report_handle_expires_at ?? null,
  };
}

/** Records that a build has been requested, BEFORE any polling (crash-safe resume). */
export async function saveReportRequested(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  handle: string,
  expiresAt: string,
  now: string,
): Promise<void> {
  await db.upsert(
    'sync_job_state',
    [
      {
        job_name: jobName,
        k_business: kBusiness,
        report_handle: handle,
        report_page: 0,
        report_handle_expires_at: expiresAt,
        last_seen_at: now,
      },
    ],
    { onConflict: 'job_name,k_business' },
  );
}

/** Advances the poll attempt so the next wait uses the next backoff rung. */
export async function bumpReportPoll(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  pollAttempt: number,
  now: string,
): Promise<void> {
  await db.upsert(
    'sync_job_state',
    [{ job_name: jobName, k_business: kBusiness, report_page: pollAttempt, last_seen_at: now }],
    { onConflict: 'job_name,k_business' },
  );
}

/** Clears the report cursor - on completion, or to abandon a timed-out build. */
export async function clearReportState(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  now: string,
): Promise<void> {
  await db.upsert(
    'sync_job_state',
    [
      {
        job_name: jobName,
        k_business: kBusiness,
        report_handle: null,
        report_page: null,
        report_handle_expires_at: null,
        last_seen_at: now,
      },
    ],
    { onConflict: 'job_name,k_business' },
  );
}
