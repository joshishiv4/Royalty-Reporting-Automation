import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runPurchaseElementSyncPass, runReceiptSyncPass } from '../src/sync/pass.js';

/**
 * Seed selects on unbounded tables MUST paginate.
 *
 * PostgREST caps a select at 1000 rows by default. Live dev sat at 14,148
 * unpriced purchases and 20,558 purchase_item rows. Without pagination each
 * seed only enqueued the first 1,000 - the pass reported ok, the queue drained
 * cleanly, and the actual data never arrived. Receipt pricing coverage stuck
 * at ~30% is the observation this test would have caught.
 */

const config = {
  env: 'dev',
  wl: { kBusiness: '111111', clientId: '', clientSecret: '', host: '', authHost: '', region: 0 },
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
  runtime: { maxConcurrency: 5, httpTimeoutMs: 30000 },
} as unknown as AppConfig;

function fakeWl(): WlClient {
  return {
    runId: 'run-x',
    request: vi.fn(() =>
      Promise.resolve({ body: {}, traceId: 't', kLog: null, httpStatus: 200, latencyMs: 1 }),
    ),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;
}

function fakeDbTracking(rowsByTable: Record<string, unknown[]>) {
  const calls: Array<{ op: string; table: string; query: string }> = [];
  const db = {
    // enqueue writes through a Postgres function now (migration 0032), so a
    // fake db has to answer it. It reports everything as inserted: these
    // tests are about what gets queued, not how Postgres resolves a clash.
    rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
    ),
    update: vi.fn(() => Promise.resolve([])),
    upsert: vi.fn((_t: string, rows: unknown[]) => Promise.resolve(rows)),
    select: vi.fn((table: string, query: string) => {
      calls.push({ op: 'select', table, query });
      // Serve rows for the seed queries, split at offset boundaries.
      const rows = rowsByTable[table] ?? [];
      const offsetMatch = query.match(/offset=(\d+)/);
      const limitMatch = query.match(/limit=(\d+)/);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      const limit = limitMatch ? Number(limitMatch[1]) : rows.length;
      return Promise.resolve(rows.slice(offset, offset + limit));
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

describe('receipt_sync seed pagination', () => {
  it('pages past the PostgREST 1000-row cap on the unpriced purchase query', async () => {
    // 2,500 unpriced purchases: one full page + one partial page.
    const unpriced = Array.from({ length: 2500 }, (_, i) => ({
      k_purchase: `p-${String(i)}`,
    }));
    const { db, calls } = fakeDbTracking({ purchase: unpriced });

    await runReceiptSyncPass(config, { wl: fakeWl(), db, now: () => 0 });

    const purchaseSelects = calls.filter(
      (c) => c.op === 'select' && c.table === 'purchase' && c.query.includes('m_total=is.null'),
    );
    // Three seed queries: offset=0, offset=1000, offset=2000 (last returns 500).
    expect(purchaseSelects.length).toBeGreaterThanOrEqual(3);
    expect(purchaseSelects.some((c) => c.query.includes('offset=0'))).toBe(true);
    expect(purchaseSelects.some((c) => c.query.includes('offset=1000'))).toBe(true);
    expect(purchaseSelects.some((c) => c.query.includes('offset=2000'))).toBe(true);
  });
});

describe('purchase_element_sync seed pagination', () => {
  it('pages past the PostgREST 1000-row cap on the purchase_item query', async () => {
    const items = Array.from({ length: 3200 }, (_, i) => ({
      k_purchase_item: `pi-${String(i)}`,
    }));
    const { db, calls } = fakeDbTracking({ purchase_item: items });

    await runPurchaseElementSyncPass(config, { wl: fakeWl(), db, now: () => 0 });

    const itemSelects = calls.filter(
      (c) =>
        c.op === 'select' &&
        c.table === 'purchase_item' &&
        c.query.includes('select=k_purchase_item'),
    );
    // Four pages needed to cover 3200 rows: 0, 1000, 2000, 3000.
    expect(itemSelects.length).toBeGreaterThanOrEqual(4);
    expect(itemSelects.some((c) => c.query.includes('offset=3000'))).toBe(true);
  });
});
