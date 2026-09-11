import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parsePurchaseList, writePurchaseList } from '../src/sync/purchases.js';

const K_BUSINESS = '111111';
const UID = '3379';

/** Two items on one purchase, one item on another - WL's keyed a_purchase shape. */
function purchaseBody(): unknown {
  return {
    a_purchase: {
      '0': {
        k_purchase_item: 'item-1',
        k_purchase: 'pur-1',
        k_location: 'loc-1',
        k_service: 'svc-9',
        s_title: 'Yoga 10-pack',
        id_sale: '4402',
        is_active: '1',
        dt_add: '2026-08-01 10:00:00',
      },
      '1': {
        k_purchase_item: 'item-2',
        k_purchase: 'pur-1', // same purchase, second item
        k_location: 'loc-1',
        s_title: 'Mat',
        is_active: 1,
      },
      '2': {
        k_purchase_item: 'item-3',
        k_purchase: 'pur-2',
        k_location: 'loc-2',
        is_active: '0',
      },
    },
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'r.1', kLog: null, httpStatus: 200, latencyMs: 7 };
}

describe('parsePurchaseList', () => {
  it('groups items under their purchase and keeps the payer uid', () => {
    const { purchases, items, locationKeys } = parsePurchaseList(purchaseBody(), K_BUSINESS, UID);

    expect(items).toHaveLength(3);
    expect(purchases).toHaveLength(2); // pur-1 (2 items) + pur-2
    expect(purchases.find((p) => p.k_purchase === 'pur-1')).toMatchObject({
      uid_payer: UID,
      k_location: 'loc-1',
      is_active: true,
    });
    // Distinct locations only.
    expect([...locationKeys].sort()).toEqual(['loc-1', 'loc-2']);
  });

  it('derives service rows (title + is_package) from the items - no service endpoint exists', () => {
    const { services } = parsePurchaseList(purchaseBody(), K_BUSINESS, UID);
    // svc-9 appears on item-1 with title "Yoga 10-pack".
    expect(services.find((s) => s.k_service === 'svc-9')).toEqual({
      k_service: 'svc-9',
      k_business: K_BUSINESS,
      title: 'Yoga 10-pack',
      is_package: false,
    });
  });

  it('maps an item, coercing id_* to integers and keeping keys as text', () => {
    const { items } = parsePurchaseList(purchaseBody(), K_BUSINESS, UID);
    const first = items.find((i) => i.k_purchase_item === 'item-1')!;
    expect(first).toMatchObject({
      k_purchase: 'pur-1',
      k_service: 'svc-9',
      text_title: 'Yoga 10-pack',
      id_sale: 4402, // string -> integer
      i_count: 1,
      is_active: true,
    });
    // No money in the list: it comes from the receipt (task 015).
    expect('m_price_total' in first).toBe(false);
  });

  it('dedupes a repeated k_purchase_item - an upsert batch cannot name it twice', () => {
    const body = {
      a_purchase: {
        '0': { k_purchase_item: 'dup', k_purchase: 'p', s_title: 'first' },
        '1': { k_purchase_item: 'dup', k_purchase: 'p', s_title: 'second' },
      },
    };
    const { items } = parsePurchaseList(body, K_BUSINESS, UID);
    expect(items).toHaveLength(1);
    expect(items[0]!.text_title).toBe('second'); // last write wins
  });

  it('treats k_location "0" as no location, not a stub', () => {
    const body = {
      a_purchase: { '0': { k_purchase_item: 'i', k_purchase: 'p', k_location: '0' } },
    };
    const { purchases, locationKeys } = parsePurchaseList(body, K_BUSINESS, UID);
    expect(locationKeys).toEqual([]); // no fake location "0" stubbed
    expect(purchases[0]!.k_location).toBeNull();
  });

  it('skips a record missing its keys, and handles an empty body', () => {
    expect(
      parsePurchaseList({ a_purchase: { '0': { s_title: 'x' } } }, K_BUSINESS, UID).items,
    ).toEqual([]);
    expect(parsePurchaseList({}, K_BUSINESS, UID).purchases).toEqual([]);
  });
});

describe('writePurchaseList', () => {
  function fakeDb() {
    const calls: Array<{ op: string; table: string; onConflict?: string; rows: unknown[] }> = [];
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-9' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], opts: { onConflict: string }) => {
        calls.push({ op: 'upsert', table, onConflict: opts.onConflict, rows });
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  it('writes raw, location stubs, purchases and items with the right conflict targets', async () => {
    const { db, calls } = fakeDb();

    const result = await writePurchaseList(db, {
      kBusiness: K_BUSINESS,
      uidPayer: UID,
      response: response(purchaseBody()),
      runId: 'run',
    });

    const seq = calls.map((c) => `${c.op}:${c.table}`);
    // raw first; location + service stubs before the rows whose FKs need them.
    expect(seq).toEqual([
      'insert:raw_wl',
      'upsert:location',
      'upsert:service',
      'upsert:purchase',
      'insert:raw_link',
      'upsert:purchase_item',
      'insert:raw_link',
    ]);
    expect(calls.find((c) => c.table === 'service')!.onConflict).toBe('k_service');
    expect(calls.find((c) => c.table === 'location')!.onConflict).toBe('k_location');
    expect(calls.find((c) => c.table === 'purchase')!.onConflict).toBe('k_purchase');
    expect(calls.find((c) => c.table === 'purchase_item')!.onConflict).toBe('k_purchase_item');
    // location stub carries only the FK-satisfying columns, so an enrich survives.
    expect(calls.find((c) => c.table === 'location')!.rows[0]).toEqual({
      k_location: 'loc-1',
      k_business: K_BUSINESS,
    });
    expect(result).toMatchObject({ purchaseCount: 2, itemCount: 3 });
  });

  it('still stores the raw payload when there is nothing to parse', async () => {
    const { db, calls } = fakeDb();
    await writePurchaseList(db, {
      kBusiness: K_BUSINESS,
      uidPayer: UID,
      response: response({}),
      runId: 'run',
    });
    expect(calls.map((c) => c.table)).toEqual(['raw_wl']);
  });
});
