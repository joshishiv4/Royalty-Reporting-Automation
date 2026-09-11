import type { SupabaseClient } from '../supabase/client.js';
import { JOB_GROUPS } from '../sync/jobs.js';

/**
 * Jobs that should have run by now and have not (PRD M10).
 *
 * WHY THIS MATTERS MORE THAN THE FAILURE ALERT. A failure produces an error
 * somebody can be told about. A job that never STARTS produces nothing at all -
 * no run row, no error, no signal of any kind. The data simply stops moving
 * while continuing to look completely plausible, and the first person to notice
 * is whoever queries it weeks later and finds it stale.
 *
 * That is the failure this file exists for, and it is the only alert here that
 * cannot be derived from something the system already wrote down. Every other
 * alert reads a record of something that happened; this one has to notice the
 * ABSENCE of a record, which means knowing what was supposed to happen.
 *
 * WHERE "SUPPOSED TO" COMES FROM. Each job group declares its own cadence, in
 * hours, beside the passes it runs. Deliberately not parsed out of vercel.json:
 * the schedule is deployment configuration and this code cannot read it at
 * runtime, so it would be inferring the answer rather than knowing it. Two
 * places to keep in step is the cost, and the test that pins them together is
 * what pays it.
 *
 * WHY ONE QUERY PER JOB AND NOT ONE BIG ONE. The obvious version - read the
 * most recent N runs and reduce - is wrong in exactly the case that matters. A
 * job overdue by three months has no row anywhere near the top of the table, so
 * a capped read of recent history would MISS it while reporting on the jobs that
 * are fine. One indexed lookup per job is a dozen small reads and it cannot have
 * that blind spot.
 */

export interface OverdueJob {
  readonly job: string;
  readonly group: string;
  readonly expectedEveryHours: number;
  /** When it last completed cleanly, or null if it never has. */
  readonly lastOkAt: string | null;
  /** Hours since that, or null when it has never run at all. */
  readonly hoursSince: number | null;
}

/**
 * How far past its cadence a job may drift before it is called overdue.
 *
 * A daily job that ran at 03:00 yesterday and is checked at 02:59 today is 23.98
 * hours old and perfectly healthy; without slack every daily job would alert
 * every single day just before its next run. Half a cadence is wide enough to
 * absorb that and a late start, and narrow enough that a job which has skipped a
 * whole cycle is still caught within the next one.
 */
const GRACE_FACTOR = 1.5;

export async function findOverdueJobs(
  db: SupabaseClient,
  kBusiness: string,
  now: number = Date.now(),
): Promise<readonly OverdueJob[]> {
  const overdue: OverdueJob[] = [];

  for (const group of JOB_GROUPS) {
    for (const pass of group.passes) {
      let lastOkAt: string | null = null;
      try {
        // state=ok, not just any row: a job that has been failing every night
        // for a week is not "running fine", and a failed run must not reset the
        // clock on the very alert that would surface it.
        const rows = await db.select<{ finished_at: string | null }>(
          'sync_run',
          `job_name=eq.${pass.job}&k_business=eq.${kBusiness}&state=eq.ok` +
            `&select=finished_at&order=finished_at.desc&limit=1`,
        );
        lastOkAt = rows[0]?.finished_at ?? null;
      } catch {
        // A read that fails tells us nothing about the job. Reporting it as
        // overdue would be inventing an alert out of our own outage.
        continue;
      }

      const allowedMs = group.expectedEveryHours * 3_600_000 * GRACE_FACTOR;
      const sinceMs = lastOkAt === null ? null : now - Date.parse(lastOkAt);

      // Never run at all is overdue by definition - and it is the case a
      // "last run was long ago" check written with a subtraction would silently
      // skip, because there is nothing to subtract from.
      if (sinceMs === null || sinceMs > allowedMs) {
        overdue.push({
          job: pass.job,
          group: group.name,
          expectedEveryHours: group.expectedEveryHours,
          lastOkAt,
          hoursSince: sinceMs === null ? null : Math.floor(sinceMs / 3_600_000),
        });
      }
    }
  }

  return overdue;
}
