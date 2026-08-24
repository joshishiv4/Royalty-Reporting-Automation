import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseShopCategoryList, writeShopCategoryList } from '../src/sync/shop-categories.js';

const KB = '111111';

// Shape probed live 24 Aug 2026: a_shop_category is an ARRAY; i_order a string.
function shopCategoryBody(): unknown {
  return {
    a_shop_category: [
      {
        k_shop_category: '1033035',
        text_title: 'Monthly Subscriptions',
        text_description: '',
        i_order: '3',
        is_default: false,
        is_system: true,
      },
      { text_title: 'No key here' }, // no k_shop_category -> skipped
    ],
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'r.1', kLog: null, httpStatus: 200, latencyMs: 3 };
}

describe('parseShopCategoryList', () => {
  it('maps title, parses i_order to an int, and reads the flags, skipping keyless records', () => {
    const rows = parseShopCategoryList(shopCategoryBody(), KB);
    expect(rows).toEqual([
      {
        k_shop_category: '1033035',
        k_business: KB,
        title: 'Monthly Subscriptions',
        description: null, // "" -> null
        i_order: 3, // "3" -> 3, not the string
        is_system: true,
        is_default: false,
      },
    ]);
  });

  it('also accepts a keyed object, not only an array', () => {
    const keyed = { a_shop_category: { '0': { k_shop_category: 'c-1', i_order: '0' } } };
    const rows = parseShopCategoryList(keyed, KB);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ k_shop_category: 'c-1', i_order: 0 });
  });

  it('returns nothing for a body without a_shop_category', () => {
    expect(parseShopCategoryList({}, KB)).toEqual([]);
  });
});

describe('writeShopCategoryList', () => {
  it('stores raw, then upserts on k_shop_category and links them', async () => {
    const calls: Array<{ op: string; table: string; onConflict?: string }> = [];
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-c' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], opts: { onConflict: string }) => {
        calls.push({ op: 'upsert', table, onConflict: opts.onConflict });
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;

    const result = await writeShopCategoryList(db, {
      kBusiness: KB,
      response: response(shopCategoryBody()),
      runId: 'run',
    });

    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual([
      'insert:raw_wl',
      'upsert:shop_category',
      'insert:raw_link',
    ]);
    expect(calls.find((c) => c.table === 'shop_category')!.onConflict).toBe('k_shop_category');
    expect(result.count).toBe(1);
  });
});
