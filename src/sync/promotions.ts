import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The promotion writer: /v1/classes/promotion -> promotion rows.
 *
 * Promotions are PER-LOCATION - the endpoint needs a k_location - but a
 * k_promotion is unique across the business, so the same promotion surfaces
 * under several locations. Upserting on k_promotion dedupes it: running every
 * location writes each promotion once, and a re-run changes nothing new.
 *
 * Probed live 24 Aug 2026: `a_promotion` is a JSON ARRAY of records shaped like
 *   {"k_promotion":<key>,"text_title":"DJ Group Class | 60 Minutes",
 *    "id_program":1,"is_active":"1","is_class":"0","is_enrollment":"0"}
 * where every k_ value is a quoted string. This inverts the CLAUDE.md rule
 * ("list endpoints return keyed objects") - so
 * the parser accepts BOTH an array and a keyed object, and a future keying
 * change on WL's side does not silently drop every row.
 */

export type PromotionRow = {
  readonly k_promotion: string;
  readonly k_business: string;
  readonly title: string | null;
  readonly id_program: string | null;
  readonly is_active: boolean;
};

export function parsePromotionList(body: unknown, kBusiness: string): PromotionRow[] {
  const rows: PromotionRow[] = [];
  for (const value of collection(asRecord(body)?.a_promotion)) {
    const rec = asRecord(value);
    const kPromotion = readString(rec, 'k_promotion');
    if (kPromotion === null) continue; // no primary key, nothing we can store
    rows.push({
      k_promotion: kPromotion,
      k_business: kBusiness,
      title: readString(rec, 'text_title'),
      // id_program arrives as a number; keep it as text, losslessly.
      id_program: readScalarAsString(rec, 'id_program'),
      is_active: wlBool(rec?.is_active),
    });
  }
  return rows;
}

export interface WritePromotionsInput {
  readonly kBusiness: string;
  /** The location this list was fetched for - promotions are per-location. */
  readonly kLocation: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export async function writePromotionList(
  db: SupabaseClient,
  input: WritePromotionsInput,
): Promise<{ rawWlId: string; count: number }> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/classes/promotion',
    targetKind: 'whole',
    // Which location's list this payload is, so a per-location fetch is traceable.
    targetKey: input.kLocation,
    runId: input.runId,
    response: input.response,
  });

  const rows = parsePromotionList(input.response.body, input.kBusiness);
  if (rows.length > 0) {
    // k_promotion is the primary key: the same promotion under a second location
    // updates in place rather than duplicating.
    await db.upsert('promotion', rows, { onConflict: 'k_promotion' });
    await linkRows(
      db,
      rawWlId,
      'promotion',
      rows.map((r) => r.k_promotion),
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

/** A value WL may send as a number OR a string, normalised to text (or null). */
function readScalarAsString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
