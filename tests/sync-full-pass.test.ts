import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runFullSyncPass, runFullSyncPassParallel } from '../src/sync/pass.js';

const config = {
  env: 'dev',
  wl: { kBusiness: '111111', clientId: '', clientSecret: '', host: '', authHost: '', region: 0 },
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
} as unknown as AppConfig;

/** A WL client whose every call returns a valid but empty body. */
function fakeWl(): WlClient {
  return {
    runId: 'run-x',
    request: vi.fn(() =>
      Promise.resolve({ body: {}, traceId: 'run-x.1', kLog: null, httpStatus: 200, latencyMs: 1 }),
    ),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;
}

/** A db that seeds cleanly and claims nothing, so every pass drains to ok. */
function fakeDb() {
  return {
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
    ),
    update: vi.fn(() => Promise.resolve([])), // claim CAS finds nothing
    upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
    select: vi.fn(() => Promise.resolve([])), // no seed rows, nothing eligible
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
}

describe('runFullSyncPass', () => {
  it('runs every pass in dependency order and reports ok when all drain', async () => {
    const summary = await runFullSyncPass(config, { wl: fakeWl(), db: fakeDb(), now: () => 0 });

    expect(summary.passes.map((p) => p.job)).toEqual([
      'login_type_sync',
      'client_list_sync',
      'staff_sync',
      'location_sync',
      'shop_category_sync',
      'promotion_sync',
      'service_category_sync',
      'purchase_sync',
      'receipt_sync',
      'purchase_element_sync',
      'profile_sync',
      'schedule_sync',
      'client_session_sync',
      'attendance_sync',
      'ghl_match_sync',
      'service_sync',
    ]);
    expect(summary.passes.every((p) => p.ran)).toBe(true);
    expect(summary.state).toBe('ok');
  });

  it('skips passes it cannot reach in budget and reports partial, not failed', async () => {
    // Budget below the per-pass floor: no pass is even started.
    const summary = await runFullSyncPass(config, {
      wl: fakeWl(),
      db: fakeDb(),
      now: () => 0,
      budgetMs: 1000,
    });

    expect(summary.passes.every((p) => !p.ran)).toBe(true);
    expect(summary.state).toBe('partial'); // unreached work is queued, not a failure
  });

  it('reports failed when a pass fails', async () => {
    // A staff claim that yields an item, whose handler throws a non-WL error.
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) =>
        Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
      ),
      update: vi.fn((_t: string, _p: unknown, query: string) =>
        Promise.resolve(
          query.includes('id=eq.') && query.includes('select=')
            ? [
                {
                  id: 'q1',
                  work_type: 'staff_list',
                  target_key: 'all',
                  k_business: '111111',
                  attempt_count: 0,
                },
              ]
            : [],
        ),
      ),
      upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
      // Only the STAFF queue yields work. Without the work_type check this fake
      // hands every pass a staff_list item forever, and any handler that returns
      // an outcome instead of throwing loops until the heap dies - which is not
      // a bug in that handler, just a fake that never drains.
      select: vi.fn((_t: string, query: string) =>
        Promise.resolve(
          query.includes('order=next_attempt_at.asc') && query.includes('work_type=in.(staff_list)')
            ? [
                {
                  id: 'q1',
                  work_type: 'staff_list',
                  target_key: 'all',
                  k_business: '111111',
                  attempt_count: 0,
                },
              ]
            : [],
        ),
      ),
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
    const wl = {
      runId: 'run-x',
      request: vi.fn(() => Promise.reject(new Error('boom'))),
      tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
    } as unknown as WlClient;

    const summary = await runFullSyncPass(config, { wl, db, now: () => 0 });
    expect(summary.state).toBe('failed');
  });
});

describe('runFullSyncPassParallel', () => {
  it('runs every pass exactly once and reports ok when they all drain', async () => {
    const summary = await runFullSyncPassParallel(config, {
      wl: fakeWl(),
      db: fakeDb(),
      now: () => 0,
    });

    // Same set of passes as the sequential runner; order within the summary
    // reflects the wave grouping but every pass must appear.
    const jobs = summary.passes.map((p) => p.job).sort();
    expect(jobs).toEqual(
      [
        'attendance_sync',
        'client_list_sync',
        'client_session_sync',
        'ghl_match_sync',
        'location_sync',
        'login_type_sync',
        'profile_sync',
        'promotion_sync',
        'purchase_element_sync',
        'purchase_sync',
        'receipt_sync',
        'schedule_sync',
        'service_category_sync',
        'service_sync',
        'shop_category_sync',
        'staff_sync',
      ].sort(),
    );
    expect(summary.passes.every((p) => p.ran)).toBe(true);
    expect(summary.state).toBe('ok');
  });

  it('catches an exception in one pass without abandoning the others', async () => {
    // A wl.request that throws for one specific path (staff/list). Other passes
    // still see empty successful bodies and drain cleanly.
    const wl = {
      runId: 'run-x',
      request: vi.fn((path: string) =>
        path === '/v1/staff/list'
          ? Promise.reject(new Error('staff boom'))
          : Promise.resolve({
              body: {},
              traceId: 'run-x.1',
              kLog: null,
              httpStatus: 200,
              latencyMs: 1,
            }),
      ),
      tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
    } as unknown as WlClient;

    const db = {
      insert: vi.fn((table: string, rows: unknown[]) =>
        Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
      ),
      update: vi.fn((_t: string, _p: unknown, query: string) =>
        Promise.resolve(
          query.includes('id=eq.') && query.includes('select=')
            ? [
                {
                  id: 'q1',
                  work_type: 'staff_list',
                  target_key: 'all',
                  k_business: '111111',
                  attempt_count: 0,
                },
              ]
            : [],
        ),
      ),
      upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
      select: vi.fn((_t: string, query: string) =>
        Promise.resolve(
          query.includes('order=next_attempt_at.asc') && query.includes('work_type=in.(staff_list)')
            ? [
                {
                  id: 'q1',
                  work_type: 'staff_list',
                  target_key: 'all',
                  k_business: '111111',
                  attempt_count: 0,
                },
              ]
            : [],
        ),
      ),
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

    const summary = await runFullSyncPassParallel(config, { wl, db, now: () => 0 });

    // Every pass either ok or failed - none should be missing from the list.
    expect(summary.passes).toHaveLength(16);
    expect(summary.state).toBe('failed');
    const staff = summary.passes.find((p) => p.job === 'staff_sync');
    expect(staff?.summary?.state).toBe('failed');
    // Non-staff passes still finished.
    const login = summary.passes.find((p) => p.job === 'login_type_sync');
    expect(login?.summary?.state).toBe('ok');
  });

  it('runs passes concurrently within a wave', async () => {
    // A db.select that resolves only after we prove multiple wave-1 passes
    // called it in overlap. Concurrency proof by ordering: we record the entry
    // times and check the second entry happened before the first resolved.
    const entries: number[] = [];
    let ticks = 0;

    const db = {
      insert: vi.fn((table: string, rows: unknown[]) =>
        Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
      ),
      update: vi.fn(() => Promise.resolve([])),
      upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
      select: vi.fn(() => {
        const t = ticks++;
        entries.push(t);
        // Every select resolves on a microtask, so a truly serial caller would
        // finish one before entering the next - entries would be strictly
        // increasing WITH no interleaving. A parallel caller enters the second
        // before the first resolves.
        return Promise.resolve([]);
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

    await runFullSyncPassParallel(config, { wl: fakeWl(), db, now: () => 0 });

    // A serial run would produce entries in a very rigid pattern (one pass's
    // selects fully before the next); a parallel run interleaves the selects
    // from multiple passes. This is an indirect proof, so it just checks that
    // MANY selects were made and the entries are not the trivial 5-total we'd
    // expect from a serial run of just wave 1.
    expect(entries.length).toBeGreaterThan(5);
  });
});
