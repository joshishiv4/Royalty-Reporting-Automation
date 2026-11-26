import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import {
  DEFAULT_FRESH_DONE_WINDOW_MS,
  DEFAULT_PRUNE_BATCH,
  DEFAULT_QUEUE_ROW_CAP,
  DEFAULT_RESOLVED_DEAD_RETENTION_MS,
  DEFAULT_RETENTION_MS,
  QUEUE_PRUNE_JOB,
  enforceQueueCap,
  pruneDoneItems,
  pruneQueue,
  pruneResolvedDeadItems,
  recordQueuePruneRun,
} from '../src/sync/queue.js';

/**
 * sync_queue stays bounded - and the danger is deleting too much, not too little.
 *
 * The table was never pruned until 0063 (13 Oct 2026, 1,506,074 'done' rows,
 * count(*) cancelled at 10,141 ms). 0063's 20-day window then held ~1.16M rows,
 * and on 26 Nov 2026 client_session_sync timed out on sync_queue again. 0073 and
 * this file take it to 3 days, add a size cap and clear resolved dead rows
 * (2 days after they died - under the done retention, see the simulation below).
 *
 * What must SURVIVE every one of those is the point of most of these cases:
 *   - 'done' rows from the last 24 hours: enqueue()'s dedupe reads them, so
 *     deleting one re-queues the same work the same day;
 *   - 'pending' and 'in_progress', including an item mid-retry (it stays on its
 *     own row as 'pending' with attempt_count > 0);
 *   - 'dead' rows whose target has NOT been done since - still failing.
 */

const T0 = Date.parse('2026-11-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Row {
  id: string;
  state: string;
  work_type: string;
  target_key: string;
  k_business: string;
  attempt_count: number;
  updated_at: string;
}

/**
 * An in-memory sync_queue that enforces what 0073's SQL enforces, with the
 * database's now() fixed at T0.
 */
function harness(rows: Row[], opts: { estimate?: () => number } = {}) {
  const table = [...rows];
  const calls: Array<{ fn: string; before?: string; limit?: number }> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const floor = new Date(T0 - DEFAULT_FRESH_DONE_WINDOW_MS).toISOString();
  const remove = (doomed: Row[]) => {
    for (const d of doomed) table.splice(table.indexOf(d), 1);
    return doomed.length;
  };

  const db = {
    rpc: vi.fn((fn: string, args: { p_before?: string; p_limit?: number }) => {
      calls.push({
        fn,
        ...(args.p_before === undefined ? {} : { before: args.p_before }),
        ...(args.p_limit === undefined ? {} : { limit: args.p_limit }),
      });
      if (fn === 'sync_queue_estimated_rows') {
        return Promise.resolve(opts.estimate?.() ?? table.length);
      }
      const limit = Math.max(args.p_limit ?? 0, 0);
      if (fn === 'prune_sync_queue') {
        // state = 'done' AND updated_at < least(p_before, now() - 24h),
        // ORDER BY updated_at, LIMIT p_limit.
        const cutoff = (args.p_before ?? '') < floor ? (args.p_before ?? '') : floor;
        const doomed = table
          .filter((r) => r.state === 'done' && r.updated_at < cutoff)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .slice(0, limit);
        return Promise.resolve(remove(doomed));
      }
      if (fn === 'prune_resolved_dead_sync_queue') {
        // state = 'dead' AND updated_at < p_before AND a LATER done row exists
        // for the same (work_type, target_key, k_business).
        const doomed = table
          .filter(
            (d) =>
              d.state === 'dead' &&
              d.updated_at < (args.p_before ?? '') &&
              table.some(
                (l) =>
                  l.state === 'done' &&
                  l.work_type === d.work_type &&
                  l.target_key === d.target_key &&
                  l.k_business === d.k_business &&
                  l.updated_at > d.updated_at,
              ),
          )
          .slice(0, limit);
        return Promise.resolve(remove(doomed));
      }
      throw new Error(`unexpected rpc ${fn}`);
    }),
    select: vi.fn((t: string, query: string) => {
      if (t !== 'sync_queue') return Promise.resolve([]);
      const before = /updated_at=lt\.([^&]+)/.exec(query)?.[1] ?? '';
      const limit = Number(/limit=(\d+)/.exec(query)?.[1] ?? '0');
      const hits = table.filter((r) => r.state === 'done' && r.updated_at < before).slice(0, limit);
      return Promise.resolve(hits.map((r) => ({ id: r.id })));
    }),
    insert: vi.fn((t: string, rs: Array<Record<string, unknown>>) => {
      for (const row of rs) inserts.push({ table: t, row });
      return Promise.resolve(rs);
    }),
  } as unknown as SupabaseClient;

  return { db, table, calls, inserts };
}

let seq = 0;
const at = (
  msAgo: number,
  state = 'done',
  target = `t${String(++seq)}`,
  attempt_count = 0,
): Row => ({
  id: `r${String(msAgo)}-${state}-${target}`,
  state,
  work_type: 'session_attendance',
  target_key: target,
  k_business: '1',
  attempt_count,
  updated_at: new Date(T0 - msAgo).toISOString(),
});

const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

describe('pruneDoneItems (the age rule)', () => {
  it('keeps every row inside the 24-hour fresh-done window', async () => {
    const keep = [at(60_000), at(12 * HOUR), at(23 * HOUR)];
    const h = harness([...keep, at(30 * DAY)]);

    const result = await pruneDoneItems(h.db, { now: () => T0 });

    expect(result.removed).toBe(1);
    expect(ids(h.table)).toEqual(ids(keep));
    // Stated as an assertion rather than a comment: the window must clear the floor.
    expect(DEFAULT_RETENTION_MS).toBeGreaterThan(DEFAULT_FRESH_DONE_WINDOW_MS);
  });

  it('keeps done rows younger than the 3-day window, removes older ones', async () => {
    const keep = [at(2 * DAY), at(3 * DAY - 60_000)];
    const h = harness([...keep, at(3 * DAY + 60_000), at(20 * DAY)]);

    const result = await pruneDoneItems(h.db, { now: () => T0 });

    expect(result.removed).toBe(2);
    expect(ids(h.table)).toEqual(ids(keep));
  });

  it('never removes a row that is not done, however old', async () => {
    const h = harness([
      at(90 * DAY, 'pending'),
      at(90 * DAY, 'pending', 'retrying', 2), // mid-retry: same row, attempt_count up
      at(90 * DAY, 'in_progress'),
      at(90 * DAY, 'failed'),
      at(90 * DAY, 'dead'),
      at(90 * DAY, 'done'),
    ]);

    const result = await pruneDoneItems(h.db, { now: () => T0 });

    expect(result.removed).toBe(1);
    expect(h.table.map((r) => r.state).sort()).toEqual([
      'dead',
      'failed',
      'in_progress',
      'pending',
      'pending',
    ]);
  });

  it('loops in batches and stops when the window is clear', async () => {
    const h = harness(Array.from({ length: 12 }, (_, i) => at((5 + i) * DAY)));

    const result = await pruneDoneItems(h.db, { now: () => T0, batch: 5 });

    expect(result.removed).toBe(12);
    // 5 + 5 + 2: the short batch ends it, so no statement is spent finding nothing.
    expect(result.batches).toBe(3);
    expect(result.done).toBe(true);
    expect(h.table).toHaveLength(0);
    expect(h.calls.every((c) => c.limit === 5)).toBe(true);
  });

  it('stops at maxBatches and says it is not finished', async () => {
    const h = harness(Array.from({ length: 50 }, (_, i) => at((5 + i) * DAY)));

    const result = await pruneDoneItems(h.db, { now: () => T0, batch: 5, maxBatches: 3 });

    expect(result.removed).toBe(15);
    expect(result.batches).toBe(3);
    expect(result.done).toBe(false);
    expect(h.table).toHaveLength(35);
  });

  it('dry run counts without deleting', async () => {
    const h = harness([at(5 * DAY), at(30 * DAY), at(1 * DAY)]);

    const result = await pruneDoneItems(h.db, { now: () => T0, dryRun: true });

    expect(result.removed).toBe(2);
    expect(h.table).toHaveLength(3);
    expect(h.calls).toHaveLength(0);
  });

  it('honours an explicit cutoff over the default window', async () => {
    const keep = at(2 * DAY);
    const h = harness([keep, at(10 * DAY)]);

    const result = await pruneDoneItems(h.db, {
      now: () => T0,
      before: new Date(T0 - 5 * DAY).toISOString(),
    });

    expect(result.removed).toBe(1);
    expect(ids(h.table)).toEqual([keep.id]);
  });
});

describe('enforceQueueCap (the size cap)', () => {
  it('does nothing but read the estimate when the table is under the cap', async () => {
    const h = harness([at(10 * DAY), at(2 * DAY)]);

    const result = await enforceQueueCap(h.db, { cap: 5, now: () => T0 });

    expect(result).toEqual({ estimatedRows: 2, cap: 5, removed: 0, overCap: false });
    expect(h.calls.map((c) => c.fn)).toEqual(['sync_queue_estimated_rows']);
  });

  it('removes the OLDEST done rows until the table is at the cap', async () => {
    const newest = [at(2 * HOUR), at(30 * HOUR), at(40 * HOUR)];
    const h = harness([at(3 * DAY), at(4 * DAY), ...newest]);

    const result = await enforceQueueCap(h.db, { cap: 3, now: () => T0 });

    expect(result.removed).toBe(2);
    expect(result.overCap).toBe(false);
    expect(ids(h.table)).toEqual(ids(newest));
  });

  it('never enters the 24-hour floor: over the cap with only fresh rows is overCap', async () => {
    // A day's volume alone over the cap. Deleting would blind enqueue's dedupe,
    // so it must be reported, not "fixed".
    const fresh = [at(1 * HOUR), at(5 * HOUR), at(20 * HOUR), at(23 * HOUR)];
    const h = harness([at(2 * DAY), ...fresh]);

    const result = await enforceQueueCap(h.db, { cap: 2, now: () => T0 });

    expect(result.removed).toBe(1);
    expect(result.overCap).toBe(true);
    expect(ids(h.table)).toEqual(ids(fresh));
    // The cutoff it asks for is the floor itself, never later.
    const asked = h.calls.filter((c) => c.fn === 'prune_sync_queue').map((c) => c.before);
    expect(
      asked.every((b) => b === new Date(T0 - DEFAULT_FRESH_DONE_WINDOW_MS).toISOString()),
    ).toBe(true);
  });

  it('never removes pending, in_progress or dead rows to meet the cap', async () => {
    const live = [
      at(30 * DAY, 'pending'),
      at(30 * DAY, 'pending', 'retrying', 3),
      at(30 * DAY, 'in_progress'),
      at(30 * DAY, 'dead'),
    ];
    const h = harness([...live, at(5 * DAY)]);

    const result = await enforceQueueCap(h.db, { cap: 1, now: () => T0 });

    expect(result.removed).toBe(1);
    expect(result.overCap).toBe(true);
    expect(ids(h.table)).toEqual(ids(live));
  });

  it('asks for no more than the excess, a batch at a time', async () => {
    const h = harness(Array.from({ length: 20 }, (_, i) => at((2 + i) * DAY)));

    const result = await enforceQueueCap(h.db, { cap: 8, batch: 5, now: () => T0 });

    expect(result.removed).toBe(12);
    expect(h.table).toHaveLength(8);
    expect(h.calls.filter((c) => c.fn === 'prune_sync_queue').map((c) => c.limit)).toEqual([
      5, 5, 2,
    ]);
  });

  it('running out of maxBatches is not overCap - the next run carries on', async () => {
    const h = harness(Array.from({ length: 20 }, (_, i) => at((2 + i) * DAY)));

    const result = await enforceQueueCap(h.db, { cap: 2, batch: 5, maxBatches: 2, now: () => T0 });

    expect(result.removed).toBe(10);
    expect(result.overCap).toBe(false);
  });
});

describe('pruneResolvedDeadItems', () => {
  it('removes a dead row older than 2 days once its target has been done since', async () => {
    const h = harness([at(10 * DAY, 'dead', 'a'), at(9 * DAY, 'done', 'a')]);

    const result = await pruneResolvedDeadItems(h.db, { now: () => T0 });

    expect(result.removed).toBe(1);
    expect(h.table.map((r) => r.state)).toEqual(['done']);
  });

  it('keeps a dead row whose target has not been done since - it is still failing', async () => {
    const unresolved = at(30 * DAY, 'dead', 'b');
    const otherTarget = at(1 * DAY, 'done', 'c');
    const doneBefore = at(40 * DAY, 'done', 'b'); // done BEFORE it died: not a fix
    const h = harness([unresolved, otherTarget, doneBefore]);

    const result = await pruneResolvedDeadItems(h.db, { now: () => T0 });

    expect(result.removed).toBe(0);
    expect(h.table).toContain(unresolved);
  });

  it('keeps a resolved dead row younger than 2 days, so the sweep can still see it', async () => {
    const recent = at(40 * HOUR, 'dead', 'd');
    const h = harness([recent, at(30 * HOUR, 'done', 'd')]);

    const result = await pruneResolvedDeadItems(h.db, { now: () => T0 });

    expect(result.removed).toBe(0);
    expect(h.table).toContain(recent);
  });
});

describe('pruneQueue (the hourly step)', () => {
  it('clears resolved dead rows BEFORE the age rule deletes their proof', async () => {
    // The dead row's only proof of resolution is a done row old enough for the
    // age rule to take. Run the other way round, the dead row stays for ever.
    const h = harness([at(10 * DAY), at(10 * DAY, 'dead', 'e'), at(9 * DAY, 'done', 'e')]);

    const result = await pruneQueue(h.db, { now: () => T0 });

    expect(h.calls.map((c) => c.fn)).toEqual([
      'prune_resolved_dead_sync_queue',
      'prune_sync_queue',
      'sync_queue_estimated_rows',
    ]);
    expect(result.state).toBe('ok');
    expect(h.table).toHaveLength(0);
  });

  it('a dead row resolved at any point is cleared by some hourly run', async () => {
    // Dies at hour 0; the retry succeeds at hour h. Run the hourly step every
    // hour for two weeks: the dead row must be gone - for every h - before the
    // done row that proves it ages out. Fails if the dead wait exceeds the
    // done retention.
    for (const successHour of [1, 24, 47, 49, 71, 100, 200]) {
      const start = T0 - 14 * DAY;
      const dead = { ...at(0, 'dead', 'z'), updated_at: new Date(start).toISOString() };
      const rows: Row[] = [dead];
      const h = harness(rows);
      for (let hour = 1; hour <= 14 * 24; hour += 1) {
        const now = start + hour * HOUR;
        if (hour === successHour) {
          h.table.push({
            ...at(0, 'done', 'z'),
            id: 'fix',
            updated_at: new Date(now).toISOString(),
          });
        }
        await pruneQueue(h.db, { now: () => now, cap: 1_000 });
      }
      expect(
        h.table.some((r) => r.state === 'dead'),
        `success at hour ${String(successHour)}`,
      ).toBe(false);
    }
  });

  it('measures the cap AFTER the age rule, so a normal day deletes nothing extra', async () => {
    // 4 rows, cap 2: the two old ones go by age; the estimate then reads 2.
    const fresh = [at(2 * DAY), at(1 * HOUR)];
    const h = harness([at(10 * DAY), at(11 * DAY), ...fresh]);

    const result = await pruneQueue(h.db, { cap: 2, now: () => T0 });

    expect(result.cap.removed).toBe(0);
    expect(ids(h.table)).toEqual(ids(fresh));
  });

  it('is partial when a step stopped at maxBatches', async () => {
    const h = harness(Array.from({ length: 30 }, (_, i) => at((5 + i) * DAY)));

    const result = await pruneQueue(h.db, { batch: 5, maxBatches: 2, now: () => T0 });

    expect(result.state).toBe('partial');
  });

  it('is failed when the cap cannot be met without entering the floor', async () => {
    const h = harness([at(1 * HOUR), at(2 * HOUR), at(3 * HOUR)]);

    const result = await pruneQueue(h.db, { cap: 1, now: () => T0 });

    expect(result.state).toBe('failed');
    expect(h.table).toHaveLength(3);
  });
});

describe('recordQueuePruneRun', () => {
  it('writes a sync_run row the alert sweep reads', async () => {
    const h = harness([]);

    await recordQueuePruneRun(h.db, {
      runId: 'abcd1234',
      kBusiness: '1',
      startedAt: '2026-11-26T11:50:00.000Z',
      finishedAt: '2026-11-26T11:51:00.000Z',
      state: 'failed',
      error: 'over the cap',
    });

    expect(h.inserts).toEqual([
      {
        table: 'sync_run',
        row: expect.objectContaining({
          run_id: 'abcd1234',
          job_name: QUEUE_PRUNE_JOB,
          state: 'failed',
          error: 'over the cap',
          finished_at: '2026-11-26T11:51:00.000Z',
        }) as unknown,
      },
    ]);
  });
});

describe('the documented defaults', () => {
  it('match the migration and the runbook', () => {
    expect(DEFAULT_PRUNE_BATCH).toBe(5000);
    expect(DEFAULT_RETENTION_MS).toBe(3 * DAY);
    expect(DEFAULT_QUEUE_ROW_CAP).toBe(300_000);
    expect(DEFAULT_RESOLVED_DEAD_RETENTION_MS).toBe(2 * DAY);
    // The dead wait must stay under the done retention, or a resolved dead row
    // outlives the done row that proves it was resolved.
    expect(DEFAULT_RESOLVED_DEAD_RETENTION_MS).toBeLessThan(DEFAULT_RETENTION_MS);
    expect(QUEUE_PRUNE_JOB).toBe('queue_prune');
  });
});
