import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { REPORT_HARD_TIMEOUT_MS } from '../src/sync/pass.js';

/**
 * The report handle has to outlive the gap between invocations.
 *
 * This is the invariant that broke, and it broke without a line of code
 * changing. `client_list_sync`, `tx_payment_sync` and `tx_item_sync` resume a WL
 * report across invocations: one asks for a build and saves a handle, a later
 * one polls it, a later one reads pages. At a 10-minute handle that worked,
 * because the schedule was a Vercel cron re-entering in seconds.
 *
 * On 18 Sep 2026 the schedule became a GitHub Actions workflow at `0 * * * *`.
 * Every handle was then already expired when the next invocation found it, so
 * the step cleared and the one after re-requested - request, clear, request,
 * clear, and never a poll. Measured 23 Sep: the two transaction jobs had NEVER
 * completed since the day they were created and `pay_transaction` held no rows;
 * `client_list_sync` had not completed since 19 Sep and `person` was 4.5 days
 * stale. Nothing failed. Every run reported `partial`, which is a normal state.
 *
 * So the constant is not free to be tuned on its own, and the schedule is not
 * free to be slowed on its own. This asserts the relationship between them, in
 * the direction that actually failed: change either and this goes red.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKFLOW = '.github/workflows/sync.yml';

/**
 * The shortest gap between two firings of a cron expression.
 *
 * Deliberately narrow: it understands the field shapes this repository actually
 * schedules and throws on anything else, rather than guessing. A wrong interval
 * here would make the test pass while the invariant is broken, which is the one
 * outcome worse than not having it.
 */
function minIntervalMs(cron: string): number {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if (minute === undefined || hour === undefined) throw new Error(`unparsed cron: ${cron}`);

  const every = /^\*\/(\d+)$/.exec(minute);
  if (every) return Number(every[1]) * 60_000;
  if (!/^\d+$/.test(minute)) throw new Error(`minute field not understood: ${cron}`);

  if (hour === '*') return 60 * 60_000; // hourly, on that minute
  if (!/^\d+$/.test(hour)) throw new Error(`hour field not understood: ${cron}`);
  if (dom === '*' && month === '*' && dow === '*') return 24 * 60 * 60_000; // daily
  return 28 * 24 * 60 * 60_000; // monthly at the shortest
}

function syncCron(): string {
  const yml = readFileSync(join(ROOT, WORKFLOW), 'utf8');
  const found = /-\s*cron:\s*['"]([^'"]+)['"]/.exec(yml);
  expect(found, `${WORKFLOW} declares no cron`).not.toBeNull();
  return (found as RegExpExecArray)[1] as string;
}

describe('the report handle outlives the schedule', () => {
  it('parses the shapes this repo schedules, and refuses the ones it cannot', () => {
    // The parser is the load-bearing part of the assertion below, so it is
    // checked rather than trusted.
    expect(minIntervalMs('0 * * * *')).toBe(60 * 60_000);
    expect(minIntervalMs('17 * * * *')).toBe(60 * 60_000);
    expect(minIntervalMs('*/15 * * * *')).toBe(15 * 60_000);
    expect(minIntervalMs('0 6 * * *')).toBe(24 * 60 * 60_000);
    expect(minIntervalMs('0 5 1 * *')).toBe(28 * 24 * 60 * 60_000);
    expect(() => minIntervalMs('0 1-4 * * *')).toThrow();
  });

  it('gives the handle more than one scheduled gap', () => {
    const interval = minIntervalMs(syncCron());
    expect(
      REPORT_HARD_TIMEOUT_MS,
      `the sync cron fires every ${String(interval / 60_000)} min but a report handle ` +
        `lives ${String(REPORT_HARD_TIMEOUT_MS / 60_000)} min - it expires before the ` +
        `next invocation can poll it, and the job can never complete`,
    ).toBeGreaterThan(interval);
  });

  it('leaves room for the runs GitHub drops', () => {
    // The hourly schedule is best-effort: Actions delays and sometimes skips
    // scheduled runs under load, and gaps of five hours were measured on 22 Sep
    // 2026 in `sync_run`. One interval of headroom is not enough, so the handle
    // is required to survive three.
    const interval = minIntervalMs(syncCron());
    expect(REPORT_HARD_TIMEOUT_MS).toBeGreaterThanOrEqual(3 * interval);
  });
});
