/**
 * Read, set or clear a job's date window - the mechanism behind every manual
 * backfill.
 *
 * A window override is an INSTRUCTION, not a setting. It changes what the next
 * run of that job reads, and the job clears it once it drains cleanly. That is
 * deliberate: a standing override is a footgun, because the run six weeks later
 * still obeys it and nobody remembers why the range looks wrong.
 *
 * THE TWO JOBS WORTH POINTING AT
 *   historical_schedule_sync   class schedules, cut into calendar months
 *   client_session_sync        private appointments
 *
 * With no override, each derives its own range - see docs/RUNBOOK.md section 7.
 *
 *   node scripts/window.mjs                                          # show all
 *   node scripts/window.mjs --job=historical_schedule_sync --start=2024-01-01 --end=2024-12-31 --apply
 *   node scripts/window.mjs --job=client_session_sync --start=2025-01-01 --apply   # start .. now
 *   node scripts/window.mjs --job=historical_schedule_sync --clear --apply
 */
import { args, banner, db, kBusiness } from './_bootstrap.mjs';

const a = args();
const apply = a['apply'] === true;

banner('date windows');

const jobs = await db.select(
  'sync_job_state',
  `k_business=eq.${kBusiness}&order=job_name.asc` +
    `&select=job_name,state,window_start_override,window_end_override,last_clean_completion_at`,
);

if (!a['job']) {
  if (jobs.length === 0) console.log('No job state recorded yet for this business.\n');
  for (const j of jobs) {
    const set = j.window_start_override !== null || j.window_end_override !== null;
    console.log(
      `${String(j.job_name).padEnd(28)} ${set ? `WINDOW ${j.window_start_override ?? '(floor)'} .. ${j.window_end_override ?? 'now'}` : 'no override - derives its own range'}`,
    );
  }
  console.log('\nPass --job=<name> with --start/--end/--clear to change one.\n');
  process.exit(0);
}

const job = a['job'];
const current = jobs.find((j) => j.job_name === job);
console.log(`job:     ${job}`);
console.log(
  `current: ${current === undefined ? 'no row yet' : current.window_start_override === null && current.window_end_override === null ? 'no override' : `${current.window_start_override ?? '(floor)'} .. ${current.window_end_override ?? 'now'}`}`,
);

if (!a['clear'] && a['start'] === undefined && a['end'] === undefined) {
  console.log('\nNothing to change. Pass --start, --end or --clear.\n');
  process.exit(0);
}

// WL rejects a bare date on the visit endpoint (`dt-date-invalid`), so a start
// is normalised to a full timestamp here rather than at three call sites.
const stamp = (d) => (d === undefined ? null : /\d{2}:\d{2}/.test(d) ? d : `${d} 00:00:00`);
const start = a['clear'] ? null : stamp(a['start']);
const end = a['clear'] ? null : stamp(a['end']);

console.log(`new:     ${a['clear'] ? 'cleared' : `${start ?? '(floor)'} .. ${end ?? 'now'}`}`);

if (!apply) {
  console.log('\nDry run. Nothing written. Add --apply to set it.\n');
  process.exit(0);
}

await db.upsert(
  'sync_job_state',
  [
    {
      job_name: job,
      k_business: kBusiness,
      window_start_override: start,
      window_end_override: end,
      last_seen_at: new Date().toISOString(),
    },
  ],
  { onConflict: 'job_name,k_business' },
);

console.log('\nWritten. The next run of that job will use it, then clear it on a clean drain.');
console.log('Trigger a run now, or wait for the schedule - see docs/RUNBOOK.md section 8.\n');
