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
        //
        // The same drain CONSUMES a one-shot window override (0031). Cleared here
        // rather than when it is read: a run that crashed before doing the work
        // would otherwise have swallowed the request silently. Honoured, then
        // gone - a standing override would make every night re-fetch the same
        // range forever while reporting success.
        ...(passState === 'ok'
          ? {
              last_clean_completion_at: now,
              window_start_override: null,
              window_end_override: null,
            }
          : {}),
      },
    ],
    { onConflict: 'job_name,k_business' },
  );
}

/**
 * The clean-completion watermark, or null if this job has never drained cleanly.
 *
 * Read rather than assumed: it is what decides whether the visit sync reaches
 * back to `SYNC_HISTORY_START` or only over the daily overlap, and a half-done
 * backfill must keep looking like a backfill.
 */
export interface WindowState {
  /** Moves only on a clean drain. Null means "never finished" - still a backfill. */
  readonly lastCleanCompletionAt: string | null;
  /** One-shot manual window (0031). Wins over the derived rule while set. */
  readonly startOverride: string | null;
  readonly endOverride: string | null;
}

export async function readWindowState(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
): Promise<WindowState> {
  const rows = await db.select<{
    last_clean_completion_at: string | null;
    window_start_override: string | null;
    window_end_override: string | null;
  }>(
    'sync_job_state',
    `job_name=eq.${jobName}&k_business=eq.${kBusiness}&limit=1` +
      `&select=last_clean_completion_at,window_start_override,window_end_override`,
  );
  const row = rows[0];
  return {
    lastCleanCompletionAt: row?.last_clean_completion_at ?? null,
    startOverride: row?.window_start_override ?? null,
    endOverride: row?.window_end_override ?? null,
  };
}

/**
 * Sets (or clears, with two nulls) a job's one-shot manual window.
 *
 * Upserts rather than updates: a window can legitimately be set for a job that
 * has never run, and a missing row should not silently swallow the request.
 */
export async function setWindowOverride(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  start: string | null,
  end: string | null,
  now: string,
): Promise<void> {
  await db.upsert(
    'sync_job_state',
    [
      {
        job_name: jobName,
        k_business: kBusiness,
        window_start_override: start,
        window_end_override: end,
        last_seen_at: now,
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

/**
 * How long a lease lasts before another run may take the job.
 *
 * Comfortably longer than a serverless invocation can live (60s on Vercel
 * Hobby), so a healthy run never loses its own lock mid-flight; short enough
 * that a died process does not block the next scheduled run. A CLI backfill runs
 * far longer than this and refreshes as it goes - see renewJobLock.
 */
export const JOB_LEASE_MS = 300_000;

/**
 * Takes the job's lease, or reports that somebody else holds it.
 *
 * A SINGLE CONDITIONAL UPDATE, not a read followed by a write. Read-then-write
 * cannot lock anything: two callers both read "free" and both proceed, which is
 * exactly the overlap this exists to stop. The condition lives in the WHERE
 * clause and PostgREST returns the rows it changed - one row means the lock is
 * ours, zero means it is not. Postgres decides. The same compare-and-swap
 * claimBatch already uses for queue items.
 *
 * `or=(locked_until.is.null,locked_until.lt.now)` is the whole rule: free, or
 * the previous holder's lease has expired. Expiry matters because the process
 * that took the lock is the only thing that would release it, and a process that
 * dies releases nothing - forty runs sat open on live dev, the oldest ten days.
 *
 * The row must already exist; openJobState upserts it. A job whose row is
 * missing therefore cannot be locked, and the caller is told it did not get the
 * lock rather than proceeding unprotected.
 */
export async function acquireJobLock(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  runId: string,
  now: string,
  leaseMs = JOB_LEASE_MS,
): Promise<boolean> {
  const until = new Date(Date.parse(now) + leaseMs).toISOString();
  const rows = await db.update(
    'sync_job_state',
    { locked_until: until, locked_by: runId },
    `job_name=eq.${jobName}&k_business=eq.${kBusiness}` +
      `&or=(locked_until.is.null,locked_until.lt.${now})&select=job_name`,
  );
  return rows.length > 0;
}

/**
 * Extends a lease we already hold.
 *
 * A CLI backfill outlives any sane lease, and a run that let its own lock expire
 * would be overtaken by the next scheduled run - the overlap again, just slower.
 * Scoped to `locked_by` so this can only ever extend OUR lease, never steal
 * somebody else's.
 */
export async function renewJobLock(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  runId: string,
  now: string,
  leaseMs = JOB_LEASE_MS,
): Promise<boolean> {
  const until = new Date(Date.parse(now) + leaseMs).toISOString();
  const rows = await db.update(
    'sync_job_state',
    { locked_until: until },
    `job_name=eq.${jobName}&k_business=eq.${kBusiness}&locked_by=eq.${runId}&select=job_name`,
  );
  return rows.length > 0;
}

/**
 * Releases the lease, but ONLY if we still hold it.
 *
 * The `locked_by` filter is the point. A run that overran its lease has already
 * been superseded; if it then released unconditionally it would unlock the job
 * out from under whoever legitimately took over, and the next scheduled run
 * would overlap with that one instead. Better to leave a lease to expire than to
 * clear somebody else's.
 */
export async function releaseJobLock(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  runId: string,
): Promise<void> {
  await db.update(
    'sync_job_state',
    { locked_until: null, locked_by: null },
    `job_name=eq.${jobName}&k_business=eq.${kBusiness}&locked_by=eq.${runId}&select=job_name`,
  );
}
