import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl, wlDate } from './writer.js';

/**
 * The purchase writer: /v1/profile/purchase/list -> purchase + purchase_item.
 *
 * The list is fetched PER uid, and every record in it is a purchase ITEM - the
 * royalty row (DATA-MODEL: the purchase item, not the purchase, is what a teacher
 * is paid on). Items are grouped by k_purchase to form the purchase header.
 *
 * TWO THINGS THIS SLICE DELIBERATELY LEAVES:
 *
 *   - MONEY. The list carries no m_* fields; a purchase's total and its payment
 *     breakdown come from /v1/purchase/receipt, one call per k_purchase. That
 *     enrichment is task 015, so money stays null here, not zero.
 *   - LOCATION DETAIL. Each item names a k_location; the writer upserts a location
 *     STUB (k_location, k_business) so purchase.k_location's FK resolves without an
 *     ordering dependency. A PostgREST upsert only writes the columns sent, so a
 *     later location/list enrich of title/timezone is not clobbered by the stub.
 *
 * FK-safe by construction: the uid we queried is already a person row (the pull is
 * seeded from person.uid), so purchase.uid_payer resolves.
 */

export type PurchaseRow = {
  readonly k_purchase: string;
  readonly k_business: string;
  readonly k_location: string | null;
  readonly uid_payer: string;
  readonly dt_add: string | null;
  readonly is_active: boolean;
};

export type PurchaseItemRow = {
  readonly k_purchase_item: string;
  readonly k_purchase: string;
  readonly k_business: string;
  readonly k_service: string | null;
  readonly k_id: string | null;
  readonly k_code: string | null;
  readonly k_appointment: string | null;
  readonly k_login_promotion: string | null;
  readonly text_title: string | null;
  readonly i_count: number;
  readonly id_purchase_item: number | null;
  readonly id_sale: number | null;
  readonly is_active: boolean;
  readonly dt_add: string | null;
};

/**
 * A `service` row derived from a purchase item. WL exposes no service-detail
 * endpoint (all /v1/service* paths 404), so the catalogue's human-readable bits -
 * title, is_package - are taken from the transactions that reference it. Upserted
 * on k_service, so this enriches the FK stub in place.
 */
export type ServiceRow = {
  readonly k_service: string;
  readonly k_business: string;
  readonly title: string | null;
  readonly is_package: boolean;
};

export interface ParsedPurchases {
  readonly purchases: readonly PurchaseRow[];
  readonly items: readonly PurchaseItemRow[];
  /** Distinct non-null k_location values, for the location stub upsert. */
  readonly locationKeys: readonly string[];
  /** Service rows (key + title + is_package) derived from the items. */
  readonly services: readonly ServiceRow[];
}

/**
 * Parses `a_purchase` into purchase headers and their items.
 *
 * `uidPayer` is the uid the list was fetched for - the list is "this person's
 * purchases", so it is the payer, and it is not always echoed on every record.
 */
export function parsePurchaseList(
  body: unknown,
  kBusiness: string,
  uidPayer: string,
): ParsedPurchases {
  const records = asRecord(asRecord(body)?.a_purchase);
  if (records === null) return { purchases: [], items: [], locationKeys: [], services: [] };

  // Keyed by their primary keys: WL can repeat a k_purchase_item across records,
  // and an upsert batch that names the same conflict key twice is rejected by
  // Postgres ("cannot affect row a second time"). Last write wins.
  const items = new Map<string, PurchaseItemRow>();
  const purchases = new Map<string, PurchaseRow>();
  const locationKeys = new Set<string>();
  const services = new Map<string, ServiceRow>();

  for (const value of Object.values(records)) {
    const rec = asRecord(value);
    const kItem = readString(rec, 'k_purchase_item');
    const kPurchase = readString(rec, 'k_purchase');
    if (kItem === null || kPurchase === null) continue; // no keys, nothing to store

    // WL uses "0" as a placeholder for "no location"; treat it as null so we do
    // not stub a fake location row and point purchases at it.
    const rawLocation = readString(rec, 'k_location');
    const kLocation = rawLocation === '0' ? null : rawLocation;
    const kService = readString(rec, 'k_service');
    const dtAdd = wlDate(readString(rec, 'dt_add'));
    const isActive = wlBool(rec?.is_active);
    if (kLocation !== null) locationKeys.add(kLocation);
    if (kService !== null) {
      services.set(kService, {
        k_service: kService,
        k_business: kBusiness,
        title: readString(rec, 's_title'),
        is_package: wlBool(rec?.is_package),
      });
    }

    items.set(kItem, {
      k_purchase_item: kItem,
      k_purchase: kPurchase,
      k_business: kBusiness,
      k_service: kService,
      k_id: readString(rec, 'k_id'),
      k_code: readString(rec, 'k_code'),
      k_appointment: readString(rec, 'k_appointment'),
      k_login_promotion: readString(rec, 'k_login_promotion'),
      text_title: readString(rec, 's_title'),
      i_count: 1,
      id_purchase_item: readInt(rec?.id_purchase_item),
      id_sale: readInt(rec?.id_sale),
      is_active: isActive,
      dt_add: dtAdd,
    });

    // First item seen for a purchase sets its header; items share k_location and
    // dt_add within a purchase.
    if (!purchases.has(kPurchase)) {
      purchases.set(kPurchase, {
        k_purchase: kPurchase,
        k_business: kBusiness,
        k_location: kLocation,
        uid_payer: uidPayer,
        dt_add: dtAdd,
        is_active: isActive,
      });
    }
  }

  return {
    purchases: [...purchases.values()],
    items: [...items.values()],
    locationKeys: [...locationKeys],
    services: [...services.values()],
  };
}

export interface WritePurchasesInput {
  readonly kBusiness: string;
  readonly uidPayer: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export interface WritePurchasesResult {
  readonly rawWlId: string;
  readonly purchaseCount: number;
  readonly itemCount: number;
}

/**
 * Stores one uid's purchases: raw payload, location stubs, purchase headers,
 * purchase items, and the links between each typed row and the payload.
 */
export async function writePurchaseList(
  db: SupabaseClient,
  input: WritePurchasesInput,
): Promise<WritePurchasesResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/profile/purchase/list',
    targetKind: 'whole',
    targetKey: input.uidPayer,
    runId: input.runId,
    response: input.response,
  });

  const { purchases, items, locationKeys, services } = parsePurchaseList(
    input.response.body,
    input.kBusiness,
    input.uidPayer,
  );

  // Stubs FIRST so the FKs on purchase.k_location and purchase_item.k_service
  // resolve. Only the key + k_business are sent, so an existing enriched row keeps
  // its other columns (a PostgREST upsert writes only the columns in the payload).
  if (locationKeys.length > 0) {
    await db.upsert(
      'location',
      locationKeys.map((k_location) => ({ k_location, k_business: input.kBusiness })),
      { onConflict: 'k_location' },
    );
  }
  if (services.length > 0) {
    await db.upsert('service', services, { onConflict: 'k_service' });
  }

  if (purchases.length > 0) {
    await db.upsert('purchase', purchases, { onConflict: 'k_purchase' });
    await linkRows(
      db,
      rawWlId,
      'purchase',
      purchases.map((p) => p.k_purchase),
    );
  }

  if (items.length > 0) {
    await db.upsert('purchase_item', items, { onConflict: 'k_purchase_item' });
    await linkRows(
      db,
      rawWlId,
      'purchase_item',
      items.map((i) => i.k_purchase_item),
    );
  }

  return { rawWlId, purchaseCount: purchases.length, itemCount: items.length };
}

function wlBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/** id_* columns are integers, but WL may send them as numeric strings. */
function readInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
