import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import { SupabaseError, type SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runStaffSyncPass } from '../src/sync/pass.js';

const config = {
  env: 'dev',
  wl: { kBusiness: '111111' },
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
  runtime: { maxConcurrency: 5, httpTimeoutMs: 30000 },
} as unknown as AppConfig;

/** A WL client whose staff call returns an empty (but valid) list, or throws. */
function fakeWl(request: () => Promise<unknown>): WlClient {
  return {
    runId: 'run-x',
    request: vi.fn(request),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;
}

interface DbScript {
  claimReturns?: unknown[]; // what a claim CAS yields (an item, or nothing)
  eligibleRemaining?: unknown[]; // countEligible result
}

function fakeDb(script: DbScript = {}) {
  const calls: Array<{
    op: string;
    table: string;
    patch?: Record<string, unknown>;
    query?: string;
  }> = [];
  const db = {
    // enqueue writes through a Postgres function now (migration 0032), so a
    // fake db has to answer it. It reports everything as inserted: these
    // tests are about what gets queued, not how Postgres resolves a clash.
    rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
    insert: vi.fn((table: string, rows: unknown[]) => {
      calls.push({ op: 'insert', table });
      return Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows);
    }),
    update: vi.fn((table: string, patch: Record<string, unknown>, query: string) => {
      calls.push({ op: 'update', table, patch, query });
      // The claim compare-and-swap is the only update that reads back a row.
      const isClaim = query.includes('id=eq.') && query.includes('select=');
      return Promise.resolve(isClaim ? (script.claimReturns ?? []) : []);
    }),
    upsert: vi.fn((table: string, rows: unknown[]) => {
      calls.push({ op: 'upsert', table });
      return Promise.resolve(rows); // sync_job_state open/close
    }),
    select: vi.fn((table: string, query: string) => {
      calls.push({ op: 'select', table, query });
      if (query.includes('limit=1000')) return Promise.resolve(script.eligibleRemaining ?? []);
      if (query.includes('order=next_attempt_at.asc'))
        return Promise.resolve(script.claimReturns ?? []);
      return Promise.resolve([]); // enqueue active-target lookup
    }),
    // selectAll pages in production (PostgREST caps a read at 1,000 rows);
    // a fake answers in one call, so it shares the select handler.
    selectAll(table: string, query: string) {
      // `this` is cast because several of these literals are inferred as {}
      // before the outer `as unknown as SupabaseClient` is applied.
      return (this as { select: (t: string, q: string) => Promise<unknown[]> }).select(
        table,
        query,
      );
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const okResponse = () =>
  Promise.resolve({
    body: { a_staff: {} },
    traceId: 'run-x.1',
    kLog: null,
    httpStatus: 200,
    latencyMs: 1,
  });

describe('runStaffSyncPass', () => {
  it('reports ok and closes the run when the queue drains', async () => {
    const { db, calls } = fakeDb({ claimReturns: [], eligibleRemaining: [] });
    const summary = await runStaffSyncPass(config, {
      wl: fakeWl(okResponse),
      db,
      now: () => 0,
    });

    expect(summary.state).toBe('ok');
    // The run is opened and then closed with a finished_at + ok state.
    const open = calls.find((c) => c.op === 'insert' && c.table === 'sync_run');
    const close = calls.find((c) => c.op === 'update' && c.table === 'sync_run');
    expect(open).toBeDefined();
    expect(close!.patch).toMatchObject({ state: 'ok' });
    expect(close!.patch!.finished_at).toBeTruthy();
  });

  it('reports partial when the budget stops the pass with work still eligible', async () => {
    const { db, calls } = fakeDb({ eligibleRemaining: [{ id: 'left' }] });
    const summary = await runStaffSyncPass(config, {
      wl: fakeWl(okResponse),
      db,
      now: () => 0,
      budgetMs: 0, // no budget: stop before claiming anything
    });

    expect(summary.state).toBe('partial');
    expect(summary.itemsRemaining).toBe(1);
    const close = calls.find((c) => c.op === 'update' && c.table === 'sync_run');
    expect(close!.patch).toMatchObject({ state: 'partial' });
  });

  // The bug fix: a transient DATABASE hiccup on one item must requeue that item
  // and let the pass carry on - not abort the whole drain the way it did live on
  // 27 Aug 2026, when one Supabase blip failed receipt_sync with 10,938 items
  // still pending.
  it('requeues the item and does NOT fail the pass when a DB write is transiently down', async () => {
    const item = {
      id: 'q1',
      work_type: 'staff_list',
      target_key: 'all',
      k_business: '111111',
      attempt_count: 0,
    };
    let claimed = false;
    const calls: Array<{ op: string; table: string; patch?: Record<string, unknown> }> = [];
    const db = {
      // The first DB write the handler makes is raw_wl; make it transiently fail.
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table });
        if (table === 'raw_wl') throw new SupabaseError('raw_wl', 503, 'service unavailable');
        return Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows);
      }),
      update: vi.fn((table: string, patch: Record<string, unknown>, query: string) => {
        calls.push({ op: 'update', table, patch });
        const isClaim = query.includes('id=eq.') && query.includes('select=');
        if (isClaim && !claimed) {
          claimed = true; // hand the item out exactly once
          return Promise.resolve([item]);
        }
        return Promise.resolve([]);
      }),
      upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
      select: vi.fn((_table: string, query: string) => {
        if (query.includes('order=next_attempt_at.asc'))
          return Promise.resolve(claimed ? [] : [item]);
        return Promise.resolve([]); // enqueue lookup + eligible-remaining
      }),
      // selectAll pages in production (PostgREST caps a read at 1,000 rows);
      // a fake answers in one call, so it shares the select handler.
      selectAll(table: string, query: string) {
        // `this` is cast because several of these literals are inferred as {}
        // before the outer `as unknown as SupabaseClient` is applied.
        return (this as { select: (t: string, q: string) => Promise<unknown[]> }).select(
          table,
          query,
        );
      },
    } as unknown as SupabaseClient;

    const summary = await runStaffSyncPass(config, { wl: fakeWl(okResponse), db, now: () => 0 });

    // Survives: not failed, and the item was requeued rather than swallowed.
    expect(summary.state).not.toBe('failed');
    expect(summary.requeued).toBe(1);
    // The requeue settle puts it back to pending for a later attempt.
    const requeue = calls.find(
      (c) => c.op === 'update' && c.table === 'sync_queue' && c.patch?.state === 'pending',
    );
    expect(requeue).toBeDefined();
  });

  it('reports failed when the handler throws a non-WL error', async () => {
    const item = {
      id: 'q1',
      work_type: 'staff_list',
      target_key: 'all',
      k_business: '111111',
      attempt_count: 0,
    };
    const { db } = fakeDb({ claimReturns: [item], eligibleRemaining: [] });
    const summary = await runStaffSyncPass(config, {
      wl: fakeWl(() => Promise.reject(new Error('boom'))),
      db,
      now: () => 0,
    });

    expect(summary.state).toBe('failed');
    // NAME *AND* REASON. This used to assert the bare class name, and recording
    // only that is how a zero date sent to a timestamptz column hid behind the
    // word "SupabaseError" while attendance_sync died on every batch. The reason
    // is scrubbed for hosts, not discarded - see scrubMessage.
    expect(summary.error).toContain('Error');
    expect(summary.error).toContain('boom');
  });
});
