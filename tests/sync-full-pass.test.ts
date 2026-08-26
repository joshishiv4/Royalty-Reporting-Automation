import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runFullSyncPass } from '../src/sync/pass.js';

const config = {
  env: 'dev',
  wl: { kBusiness: '111111', clientId: '', clientSecret: '', host: '', authHost: '', region: 0 },
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
  } as unknown as SupabaseClient;
}

describe('runFullSyncPass', () => {
  it('runs every pass in dependency order and reports ok when all drain', async () => {
    const summary = await runFullSyncPass(config, { wl: fakeWl(), db: fakeDb(), now: () => 0 });

    expect(summary.passes.map((p) => p.job)).toEqual([
      'login_type_sync',
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
