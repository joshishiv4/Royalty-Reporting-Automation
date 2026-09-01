/**
 * Put given-up items back on the queue so the next run tries them again.
 *
 * DRY RUN BY DEFAULT. It prints what it would change and exits. `--apply` is
 * required to write anything. The reason is not caution for its own sake: the
 * natural mistake here is re-queueing a whole work_type when only one cause
 * within it is worth retrying, and that mistake is invisible until the same
 * items die again the next night.
 *
 * WHAT IT WRITES. state -> pending, attempt_count -> 0, next_attempt_at -> now.
 * The error fields are deliberately LEFT ALONE: if the item dies again, having
 * the previous error still on the row is what shows it is the same failure
 * rather than a new one.
 *
 *   node scripts/requeue.mjs                                   # dry run, everything dead
 *   node scripts/requeue.mjs --work-type=purchase_receipt
 *   node scripts/requeue.mjs --sid=id-nx --invert              # everything EXCEPT id-nx
 *   node scripts/requeue.mjs --work-type=user_profile --apply
 *   node scripts/requeue.mjs --state=failed --apply            # stuck retries, not dead
 */
import { args, banner, db, kBusiness, selectPaged } from './_bootstrap.mjs';

const a = args();
const state = a['state'] ?? 'dead';
const apply = a['apply'] === true;

banner(`re-queue items in state "${state}"${apply ? '  [APPLY]' : '  [DRY RUN]'}`);

let filter = `k_business=eq.${kBusiness}&state=eq.${state}`;
if (a['work-type']) filter += `&work_type=eq.${a['work-type']}`;
if (a['sid']) filter += a['invert'] ? `&last_error_sid=neq.${a['sid']}` : `&last_error_sid=eq.${a['sid']}`;

const rows = await selectPaged(
  'sync_queue',
  `${filter}&select=work_type,target_key,last_error_sid,attempt_count`,
);

if (rows.length === 0) {
  console.log('Nothing matches. Nothing to do.\n');
  process.exit(0);
}

const byType = new Map();
for (const r of rows) {
  const key = `${r.work_type}  ${r.last_error_sid ?? '(no sid)'}`;
  byType.set(key, (byType.get(key) ?? 0) + 1);
}
console.log(`${rows.length} item(s) match:\n`);
for (const [key, count] of [...byType.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${String(count).padStart(6)}  ${key}`);
}

if (rows.some((r) => r.last_error_sid === 'id-nx')) {
  console.log(
    '\nWARNING: some of these are id-nx - WellnessLiving says the record does not exist.\n' +
      'Re-queueing those will fail again, three attempts at a time, every run. Consider\n' +
      '--sid=id-nx --invert to leave them out.',
  );
}

if (!apply) {
  console.log('\nDry run. Nothing written. Add --apply to re-queue these.\n');
  process.exit(0);
}

// update(table, patch, query) - patch second, not the query.
await db.update(
  'sync_queue',
  { state: 'pending', attempt_count: 0, next_attempt_at: new Date().toISOString() },
  filter,
);

console.log(`\nRe-queued ${rows.length} item(s). They will be picked up by the next run.`);
console.log('Trigger one now, or wait for the schedule - see docs/RUNBOOK.md section 8.\n');
