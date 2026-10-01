import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every state the code writes to sync_run must be one the database accepts.
 *
 * runPass() closed a stood-down run as 'skipped' from 0035 on, but the CHECK
 * constraint (last rebuilt by 0033) never allowed it: every stand-down was
 * rejected and left a row stuck on 'running' (1 Oct 2026, fixed by 0051). A
 * fake db accepts anything, so no unit test could see it. This one reads the
 * constraint the migrations actually leave behind.
 */
const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');

/** The state list from the LAST migration that (re)defines sync_run_state_check. */
function allowedRunStates(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let last: string[] | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const re = /constraint\s+sync_run_state_check\s+check\s*\(\s*state\s+in\s*\(([^)]*)\)/gi;
    for (const m of sql.matchAll(re)) {
      last = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((s) => s[1]!);
    }
  }
  if (last === null) throw new Error('no migration defines sync_run_state_check');
  return last;
}

describe('sync_run state constraint', () => {
  // runPass's closeRun writes SyncPassSummary['state']; openRun writes
  // 'running'; the heartbeat sweep writes 'abandoned'.
  const WRITTEN_BY_CODE = ['running', 'ok', 'partial', 'failed', 'skipped', 'abandoned'];

  it.each(WRITTEN_BY_CODE)('accepts %s', (state) => {
    expect(allowedRunStates()).toContain(state);
  });
});
