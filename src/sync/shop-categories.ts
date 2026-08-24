import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The shop-category writer: /v1/shop/category -> shop_category rows.
 *
 * Genuinely business-wide: probed live 24 Aug 2026 the endpoint answers with NO
 * k_location, one call for the whole business. `a_shop_category` is a JSON ARRAY
 * of records shaped like
 *   {"k_shop_category":<key>,"text_title":"Monthly Subscriptions",
 *    "text_description":"","i_order":"0","is_default":false,"is_system":false}
 * where the key is a quoted string. As with promotions this inverts the
 * CLAUDE.md "keyed object" rule, so the
 * parser accepts both an array and a keyed object.
 */

export type ShopCategoryRow = {
  readonly k_shop_category: string;
  readonly k_business: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly i_order: number | null;
  readonly is_system: boolean;
  readonly is_default: boolean;
};

export function parseShopCategoryList(body: unknown, kBusiness: string): ShopCategoryRow[] {
  const rows: ShopCategoryRow[] = [];
  for (const value of collection(asRecord(body)?.a_shop_category)) {
    const rec = asRecord(value);
    const kShopCategory = readString(rec, 'k_shop_category');
    if (kShopCategory === null) continue; // no primary key, nothing we can store
    rows.push({
      k_shop_category: kShopCategory,
      k_business: kBusiness,
      title: readString(rec, 'text_title'),
      description: readString(rec, 'text_description'),
      // Arrives as a numeric string; kept as an integer so ordering is numeric.
      i_order: readInt(rec, 'i_order'),
      is_system: wlBool(rec?.is_system),
      is_default: wlBool(rec?.is_default),
    });
  }
  return rows;
}

export interface WriteShopCategoriesInput {
  readonly kBusiness: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export async function writeShopCategoryList(
  db: SupabaseClient,
  input: WriteShopCategoriesInput,
): Promise<{ rawWlId: string; count: number }> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/shop/category',
    targetKind: 'whole',
    runId: input.runId,
    response: input.response,
  });

  const rows = parseShopCategoryList(input.response.body, input.kBusiness);
  if (rows.length > 0) {
    // k_shop_category is the primary key: re-running updates in place.
    await db.upsert('shop_category', rows, { onConflict: 'k_shop_category' });
    await linkRows(
      db,
      rawWlId,
      'shop_category',
      rows.map((r) => r.k_shop_category),
    );
  }
  return { rawWlId, count: rows.length };
}

/** Iterates a WL collection whether it arrived as an array or a keyed object. */
function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  return rec === null ? [] : Object.values(rec);
}

/** WL booleans arrive as `true`, `1`, or `"1"`; anything else is false. */
function wlBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A small integer WL sends as a numeric string ("3") or a number. Null if neither. */
function readInt(rec: Record<string, unknown> | null, key: string): number | null {
  const v = rec?.[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}
