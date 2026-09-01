/**
 * "What is the sync doing, and is it finished?" - the first thing to run.
 *
 * Three questions in one screen, because answering them separately is how an
 * on-call session starts by opening three tools:
 *
 *   1. how much work is left, per stage        (sync_queue_progress)
 *   2. what each stage last did, and when      (sync_job_state)
 *   3. what has been given up on               (dead counts, with reasons)
 *
 * Read-only. Safe to run against prod at any time.
 *
 *   node scripts/queue-status.mjs
 */
import { banner, db, kBusiness, selectPaged } from './_bootstrap.mjs';

banner('queue status');

const progress = await db.select(
  'sync_queue_progress',
  `k_business=eq.${kBusiness}&order=work_type.asc`,
);

if (progress.length === 0) {
  console.log('The queue is empty. Nothing has been seeded for this business yet.\n');
} else {
  const n = (v) => String(v ?? 0).padStart(7);
  console.log('work type'.padEnd(28) + 'pending in prog    done  failed    dead   done%');
  console.log('-'.repeat(28 + 7 * 6 + 2));
  let anyOutstanding = false;
  for (const r of progress) {
    const outstanding = Number(r.pending ?? 0) + Number(r.in_progress ?? 0);
    if (outstanding > 0) anyOutstanding = true;
    console.log(
      String(r.work_type).padEnd(28) +
        n(r.pending) +
        n(r.in_progress) +
        n(r.done) +
        n(r.failed) +
        n(r.dead) +
        String(r.pct_done ?? 0).padStart(8),
    );
  }
  console.log(
    `\n${anyOutstanding ? 'WORK OUTSTANDING - a further run is needed.' : 'Nothing outstanding. The queue has drained.'}`,
  );
}

const jobs = await db.select(
  'sync_job_state',
  `k_business=eq.${kBusiness}&order=job_name.asc` +
    `&select=job_name,state,last_seen_at,last_clean_completion_at,window_start_override,window_end_override`,
);

if (jobs.length > 0) {
  console.log('\njob'.padEnd(29) + 'state     last seen             last clean drain');
  console.log('-'.repeat(28 + 10 + 22 + 20));
  for (const j of jobs) {
    console.log(
      String(j.job_name).padEnd(28) +
        String(j.state ?? '-').padEnd(10) +
        String(j.last_seen_at ?? '-')
          .slice(0, 19)
          .padEnd(22) +
        String(j.last_clean_completion_at ?? 'never').slice(0, 19),
    );
  }
  // A window override is a pending instruction, not a setting: it changes what
  // the NEXT run reads and then clears itself. Anyone diagnosing "why did it
  // read that range" needs to see it without being told to look.
  const windows = jobs.filter(
    (j) => j.window_start_override !== null || j.window_end_override !== null,
  );
  if (windows.length > 0) {
    console.log('\nPENDING WINDOW REQUESTS - these override the normal range on the next run:');
    for (const w of windows) {
      console.log(
        `  ${w.job_name}: ${w.window_start_override ?? '(from the configured floor)'} .. ${w.window_end_override ?? 'now'}`,
      );
    }
  }
}

const dead = await selectPaged(
  'sync_queue',
  `k_business=eq.${kBusiness}&state=eq.dead&select=work_type,last_error_sid,last_http_status`,
);

if (dead.length === 0) {
  console.log('\nNothing has been given up on.\n');
} else {
  const groups = new Map();
  for (const d of dead) {
    const key = `${d.work_type}|${d.last_error_sid ?? `HTTP ${d.last_http_status ?? '?'}`}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  console.log(`\n${dead.length} item(s) GIVEN UP ON, grouped by cause:`);
  for (const [key, count] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    const [workType, reason] = key.split('|');
    console.log(`  ${String(count).padStart(6)}  ${workType.padEnd(26)} ${reason}`);
  }
  console.log('\n  Detail:   node scripts/dead-items.mjs');
  console.log('  Re-queue: node scripts/requeue.mjs --work-type=<type>\n');
}
