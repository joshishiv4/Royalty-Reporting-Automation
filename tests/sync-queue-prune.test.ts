import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import {
  DEFAULT_FRESH_DONE_WINDOW_MS,
  DEFAULT_PRUNE_BATCH,
  DEFAULT_RETENTION_MS,
  pruneDoneItems,
} from '../src/sync/queue.js';

/**
 * Retention for sync_queue's 'done' rows, and the floor underneath it.
 *
 * The table was never pruned. By 13 Oct 2026 it held 1,506,074 'done' rows,
 * count(*) over it no longer completed (cancelled at 10,141 ms), and
 * attendance_sync failed inside enqueue_sync_items with a statement timeout,
 * leaving 3,500 items unqueued. Two indexes (0050, 0060) each moved that
 * bottleneck without shrinking the table.
 *
 * The danger in the fix is deleting too much, not too little: enqueue reads
 * today's 'done' rows to decide whether a target was already refreshed, so a
 * window shorter than 24 hours makes the dedupe blind and re-queues work the
 * same day. These prove the 20-day window clears that floor, and that the prune
 * takes nothing but 'done'.
 */

const T0 = Date.parse('2026-10-13T12:00:00.000Z');

interface Row {
  id: string;
  state: string;
  updated_at: string;
}

/** An in-memory sync_queue that enforces what 0063's SQL enforces. */
function harness(rows: Row[]) {
  const table = [...rows];
  const calls: Array<{ before: string; limit: number }> = [];

  const db = {
    rpc: vi.fn((fn: string, args: { p_before: string; p_limit: number }) => {
      if (fn !== 'prune_sync_queue') throw new Error(`unexpected rpc ${fn}`);
      calls.push({ before: args.p_before, limit: args.p_limit });
      // state = 'done' AND updated_at < p_before, LIMIT p_limit.
      const doomed = table
        .filter((r) => r.state === 'done' && r.updated_at < args.p_before)
        .slice(0, Math.max(args.p_limit, 0));
      for (const d of doomed) table.splice(table.indexOf(d), 1);
      return Promise.resolve(doomed.length);
    }),
    select: vi.fn((t: string, query: string) => {
      if (t !== 'sync_queue') return Promise.resolve([]);
      const before = /updated_at=lt\.([^&]+)/.exec(query)?.[1] ?? '';
      const limit = Number(/limit=(\d+)/.exec(query)?.[1] ?? '0');
      const hits = table.filter((r) => r.state === 'done' && r.updated_at < before).slice(0, limit);
      return Promise.resolve(hits.map((r) => ({ id: r.id })));
    }),
  } as unknown as SupabaseClient;

  return { db, table, calls };
}

const at = (msAgo: number, state = 'done'): Row => ({
  id: `r${String(msAgo)}-${state}`,
  state,
  updated_at: new Date(T0 - msAgo).toISOString(),
});

const DAY = 24 * 60 * 60 * 1000;

describe('pruneDoneItems', () => {
  it('keeps every row inside the 24-hour fresh-done window', async () => {
    // The floor. enqueue() reads these to decide a target was already refreshed
    // today; delete one and it re-queues the same work the same day.
    const h = harness([
      at(1 * 60 * 1000), // a minute ago
      at(12 * 60 * 60 * 1000), // half a day
      at(23 * 60 * 60 * 1000), // just inside 24h
      at(30 * DAY), // and one genuinely old row, so the prune has work
    ]);

    const result = await pruneDoneItems(h.db, { now: () => T0 });

    expect(result.removed).toBe(1);
    expect(h.table.map((r) => r.id)).toEqual(['r60000-done', 'r43200000-done', 'r82800000-done']);
    // Stated as an assertion rather than a comment: the window must clear the floor.
    expect(DEFAULT_RETENTION_MS).toBeGreaterThan(DEFAULT_FRESH_DONE_WINDOW_MS);
  });

  it('keeps done rows younger than the 20-day window, removes older ones', async () => {
    const h = harness([at(19 * DAY), at(20 * DAY - 60_000), at(20 * DAY + 60_000), at(60 * DAY)]);

    const result = await pruneDoneItems(h.db, { now: () => T0 });

    expect(result.removed).toBe(2);
    expect(h.table.map((r) => r.id).sort()).toEqual(
      [`r${String(19 * DAY)}-done`, `r${String(20 * DAY - 60_000)}-done`].sort(),
    );
  });

  it('never removes a row that is not done, however old', async () => {
    // Outstanding work, and the record of what was given up on - the first thing
    // an operator reads at 2am.
    const h = harness([
      at(90 * DAY, 'pending'),
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
    ]);
  });

  it('loops in batches and stops when the window is clear', async () => {
    const h = harness(Array.from({ length: 12 }, (_, i) => at((25 + i) * DAY)));

    const result = await pruneDoneItems(h.db, { now: () => T0, batch: 5 });

    expect(result.removed).toBe(12);
    // 5 + 5 + 2: the short batch ends it, so no statement is spent finding nothing.
    expect(result.batches).toBe(3);
    expect(result.done).toBe(true);
    expect(h.table).toHaveLength(0);
    expect(h.calls.every((c) => c.limit === 5)).toBe(true);
  });

  it('stops at maxBatches and says it is not finished', async () => {
    // The first run meets a backlog that will not clear in one go. A loop with no
    // bound is how a cleanup becomes an outage.
    const h = harness(Array.from({ length: 50 }, (_, i) => at((25 + i) * DAY)));

    const result = await pruneDoneItems(h.db, { now: () => T0, batch: 5, maxBatches: 3 });

    expect(result.removed).toBe(15);
    expect(result.batches).toBe(3);
    expect(result.done).toBe(false);
    expect(h.table).toHaveLength(35);
  });

  it('dry run counts without deleting', async () => {
    const h = harness([at(25 * DAY), at(30 * DAY), at(1 * DAY)]);

    const result = await pruneDoneItems(h.db, { now: () => T0, dryRun: true });

    expect(result.removed).toBe(2);
    expect(h.table).toHaveLength(3);
    expect(h.calls).toHaveLength(0);
  });

  it('honours an explicit cutoff over the default window', async () => {
    const h = harness([at(3 * DAY), at(10 * DAY)]);

    const result = await pruneDoneItems(h.db, {
      now: () => T0,
      before: new Date(T0 - 5 * DAY).toISOString(),
    });

    expect(result.removed).toBe(1);
    expect(h.table.map((r) => r.id)).toEqual(['r259200000-done']);
  });

  it('defaults to a batch size the migration documents', () => {
    expect(DEFAULT_PRUNE_BATCH).toBe(5000);
    expect(DEFAULT_RETENTION_MS).toBe(20 * DAY);
  });
});
