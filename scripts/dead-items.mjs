/**
 * Everything the queue has given up on, and why.
 *
 * `queue-status` gives the counts; this gives the rows behind them - the error
 * WellnessLiving actually returned, how many attempts it took to stop, and when
 * it stopped. That distinction matters: "84 dead in attendance" is a number,
 * while "84 dead, all id-nx, all appointment keys" is a diagnosis.
 *
 * Read-only.
 *
 *   node scripts/dead-items.mjs
 *   node scripts/dead-items.mjs --work-type=purchase_receipt
 *   node scripts/dead-items.mjs --state=failed        # still retrying, not dead
 *   node scripts/dead-items.mjs --limit=50 --verbose  # full error text
 */
import { args, banner, kBusiness, selectPaged } from './_bootstrap.mjs';

const a = args();
const state = a['state'] ?? 'dead';
const limit = Number(a['limit'] ?? 20);

banner(`items in state "${state}"`);

let query =
  `k_business=eq.${kBusiness}&state=eq.${state}` +
  `&select=work_type,target_key,attempt_count,last_error,last_error_sid,last_http_status,updated_at` +
  `&order=updated_at.desc`;
if (a['work-type']) query += `&work_type=eq.${a['work-type']}`;

const rows = await selectPaged('sync_queue', query);

if (rows.length === 0) {
  console.log(`No items in state "${state}"${a['work-type'] ? ` for ${a['work-type']}` : ''}.\n`);
  process.exit(0);
}

// Grouped by (work_type, reason) because that is the unit of action: everything
// in one group needs the same next step, and listing them individually invites
// somebody to work through 800 rows that share one cause.
const groups = new Map();
for (const r of rows) {
  const reason = r.last_error_sid ?? (r.last_http_status ? `HTTP ${r.last_http_status}` : 'unknown');
  const key = `${r.work_type}||${reason}`;
  const g = groups.get(key) ?? { workType: r.work_type, reason, rows: [] };
  g.rows.push(r);
  groups.set(key, g);
}

console.log(`${rows.length} item(s) in ${groups.size} group(s).\n`);

for (const g of [...groups.values()].sort((x, y) => y.rows.length - x.rows.length)) {
  console.log(`${'='.repeat(70)}`);
  console.log(`${g.rows.length} x  ${g.workType}   reason: ${g.reason}`);
  const newest = g.rows[0];
  console.log(`  last seen: ${String(newest.updated_at).slice(0, 19)}`);
  console.log(`  attempts:  ${newest.attempt_count}`);
  if (a['verbose']) console.log(`  error:     ${newest.last_error ?? '(none recorded)'}`);
  const shown = g.rows.slice(0, limit).map((r) => r.target_key);
  console.log(`  keys:      ${shown.join(', ')}${g.rows.length > shown.length ? ` … and ${g.rows.length - shown.length} more` : ''}`);
  console.log(`  re-queue:  node scripts/requeue.mjs --work-type=${g.workType} --apply`);
}
console.log(`${'='.repeat(70)}\n`);
console.log('id-nx means WellnessLiving says the record does not exist. Retrying will not help -');
console.log('those are usually deletions upstream, and the right action is to delete the rows,');
console.log('not re-queue them. See docs/RUNBOOK.md section 9.\n');
