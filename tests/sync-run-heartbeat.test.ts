import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import { runStaffSyncPass } from '../src/sync/pass.js';

/**
 * sync_run could not answer the one question it exists for.
 *
 * closeRun() is the only thing that moves a run off 'running', so a process that
 * dies leaves the row saying 'running' forever. FORTY such rows had piled up by
 * 31 Aug 2026, the oldest from the 21st - so "is a sync running right now?"
 * always came back yes, and a live run was indistinguishable from a corpse.
 *
 * That is what let the 23505 in: two attendance_sync runs overlapped, one of
 * them a corpse from 06:32 nobody had noticed, and the collision killed the pass
 * with 32,440 items unqueued. A wrong answer to "is something already running"
 * is what allowed the race.
 *
 * The fix copies what already works for queue ITEMS - a lease, and a sweep for
 * whatever outlived it - rather than inventing a second mechanism that behaves
 * almost the same.
 */

const K_BUSINESS = '111111';
const config = {
  env: 'dev',
  wl: { kBusiness: K_BUSINESS },
  runtime: { maxConcurrency: 2 },
} as unknown as AppConfig;

/** Records every write to sync_run, in order. */
function harness() {
  const runInserts: Array<Record<string, unknown>> = [];
  const runUpdates: Array<{ patch: Record<string, unknown>; query: string }> = [];
  const order: string[] = [];

  const db = {
    insert: vi.fn((table: string, rows: Array<Record<string, unknown>>) => {
      if (table === 'sync_run') {
        order.push('open');
        runInserts.push(rows[0] ?? {});
      }
      return Promise.resolve(rows);
    }),
    upsert: vi.fn((_t: string, rows: unknown[]) => Promise.resolve(rows)),
    rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
    update: vi.fn((table: string, patch: Record<string, unknown>, query: string = '') => {
      if (table === 'sync_run') {
        if (patch.state === 'abandoned') order.push('sweep');
        else if (Object.keys(patch).length === 1 && 'heartbeat_at' in patch) order.push('beat');
        else order.push('close');
        runUpdates.push({ patch, query });
      }
      return Promise.resolve([]);
    }),
    select: vi.fn(() => Promise.resolve([])),
    selectAll: vi.fn(() => Promise.resolve([])),
  } as unknown as SupabaseClient;

  const wl = {
    request: vi.fn(() =>
      Promise.resolve({ body: {}, traceId: 't', kLog: null, httpStatus: 200, latencyMs: 1 }),
    ),
    tokenStatus: () => ({ fetchCount: 1 }),
    runId: 'run-1',
  };

  return { db, wl, runInserts, runUpdates, order };
}

const run = (h: ReturnType<typeof harness>) =>
  runStaffSyncPass(config, { db: h.db, wl: h.wl as never, now: () => 0, budgetMs: 5_000 });

describe('a run says it is alive', () => {
  it('starts the heartbeat when the run opens', async () => {
    const h = harness();
    await run(h);

    // A row that never beats again is a process that died before its first
    // batch - which has to be distinguishable from one that never started.
    expect(h.runInserts[0]).toHaveProperty('heartbeat_at');
    expect(h.runInserts[0]?.state).toBe('running');
  });

  it('beats again as it drains', async () => {
    const h = harness();
    await run(h);

    expect(h.order.filter((o) => o === 'beat').length).toBeGreaterThan(0);
  });

  it('beats between batches, not per item', async () => {
    const h = harness();
    await run(h);

    // One beat per drained batch. A beat per item would be a database write per
    // item to say nothing new.
    const beats = h.runUpdates.filter(
      (u) => 'heartbeat_at' in u.patch && u.patch.state === undefined,
    );
    for (const b of beats) expect(Object.keys(b.patch)).toEqual(['heartbeat_at']);
  });
});

describe('a run that stopped beating is retired', () => {
  /**
   * Sweeping BEFORE opening matters. Sweeping afterwards would leave a window
   * in which the table still claims dead runs are alive - which is the whole
   * failure being fixed, just narrower.
   */
  it('sweeps stale runs before opening its own', async () => {
    const h = harness();
    await run(h);

    expect(h.order[0]).toBe('sweep');
    expect(h.order[1]).toBe('open');
  });

  it('only touches runs that still claim to be running', async () => {
    const h = harness();
    await run(h);

    const sweep = h.runUpdates.find((u) => u.patch.state === 'abandoned');
    expect(sweep?.query).toContain('state=eq.running');
    expect(sweep?.query).toContain('heartbeat_at=lt.');
  });

  // 'failed' means the run caught something and said so; 'cancelled' means a
  // person stopped it. Neither describes a process that vanished, and the
  // difference is what tells you something is killing processes.
  it('records it as abandoned, not as a failure or a cancellation', async () => {
    const h = harness();
    await run(h);

    const sweep = h.runUpdates.find((u) => u.patch.state === 'abandoned');
    expect(sweep?.patch.state).toBe('abandoned');
    expect(sweep?.patch.error).toContain('no heartbeat');
  });

  // sync_run_finished_together: a row leaving 'running' must say when it stopped.
  it('sets a finish time, which the table constraint requires', async () => {
    const h = harness();
    await run(h);

    const sweep = h.runUpdates.find((u) => u.patch.state === 'abandoned');
    expect(sweep?.patch.finished_at).toBeDefined();
  });
});

describe('the run still closes itself normally', () => {
  it('records its real outcome, not an abandonment', async () => {
    const h = harness();
    await run(h);

    expect(h.order[h.order.length - 1]).toBe('close');
    const close = h.runUpdates[h.runUpdates.length - 1];
    expect(close?.patch.state).not.toBe('abandoned');
    expect(close?.patch.finished_at).toBeDefined();
  });
});
