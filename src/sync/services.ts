import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The service-catalogue writer: the bookable services and their categories.
 *
 *   /v1/appointment/book/service/category -> service_category  (a_category, ARRAY)
 *   /v1/appointment/book/service/list     -> service           (a_service, KEYED OBJECT)
 *
 * BOTH ARE PER-LOCATION - each endpoint needs a k_location. A k_service and a
 * k_service_category are unique across the business, so the same one surfaces
 * under several locations; upserting on the key dedupes it (a re-run, and a
 * second location, change nothing new).
 *
 * WHAT "RESOLVED" MEANS. Task 020 could only DERIVE a service's title from the
 * purchase items that referenced it (no service endpoint was known then). This is
 * the real catalogue, found live 24 Aug 2026 under the appointment/book path. A
 * service written from here is marked `is_resolved: true` - it was seen in the
 * catalogue. A service that only ever arrived as a purchase/appointment FK stub
 * keeps `is_resolved` false (the purchase writer never sends the column, and a
 * PostgREST upsert writes only the columns sent), so the two are distinguishable
 * and the gap is countable via the `unresolved_service` view. See migration 0012.
 *
 * TWO CLAUDE.md TRAPS, ONE EACH WAY. `a_category` is an ARRAY (not the usual keyed
 * object); `a_service` IS a keyed object (the usual rule). The category parser
 * accepts both shapes defensively; the service parser iterates Object.values.
 */

// -----------------------------------------------------------------------------
// service_category
// -----------------------------------------------------------------------------

export type ServiceCategoryRow = {
  readonly k_service_category: string;
  readonly k_business: string;
  readonly title: string | null;
  readonly i_sort: number | null;
  readonly hide_application: boolean;
};

export function parseServiceCategoryList(body: unknown, kBusiness: string): ServiceCategoryRow[] {
  const rows: ServiceCategoryRow[] = [];
  for (const value of collection(asRecord(body)?.a_category)) {
    const rec = asRecord(value);
    const kCategory = readString(rec, 'k_service_category');
    if (kCategory === null) continue; // no primary key, nothing we can store
    rows.push({
      k_service_category: kCategory,
      k_business: kBusiness,
      title: readString(rec, 's_title'),
      // Arrives as a numeric string ("29932"); kept as an integer so ordering is
      // numeric and not lexical.
      i_sort: readInt(rec, 'i_sort'),
      hide_application: wlBool(rec?.hide_application),
    });
  }
  return rows;
}

export interface WriteServiceCategoriesInput {
  readonly kBusiness: string;
  /** The location this list was fetched for - categories are per-location. */
  readonly kLocation: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export async function writeServiceCategoryList(
  db: SupabaseClient,
  input: WriteServiceCategoriesInput,
): Promise<{ rawWlId: string; count: number }> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/appointment/book/service/category',
    targetKind: 'whole',
    targetKey: input.kLocation,
    runId: input.runId,
    response: input.response,
  });

  const rows = parseServiceCategoryList(input.response.body, input.kBusiness);
  if (rows.length > 0) {
    await db.upsert('service_category', rows, { onConflict: 'k_service_category' });
    await linkRows(
      db,
      rawWlId,
      'service_category',
      rows.map((r) => r.k_service_category),
    );
  }
  return { rawWlId, count: rows.length };
}

// -----------------------------------------------------------------------------
// service (catalogue)
// -----------------------------------------------------------------------------

/**
 * A `service` row from the bookable catalogue. `is_resolved` is always true here
 * (that is what this endpoint proves); the purchase writer's stub is the false
 * case. `is_package` is deliberately absent - the catalogue does not carry it, so
 * this writer never sends it and never clobbers the purchase-derived value.
 */
export type ServiceCatalogueRow = {
  readonly k_service: string;
  readonly k_business: string;
  readonly title: string | null;
  readonly k_service_category: string | null;
  readonly i_duration: number | null;
  readonly is_bookable: boolean;
  readonly is_resolved: true;
};

export function parseServiceList(body: unknown, kBusiness: string): ServiceCatalogueRow[] {
  // a_service is a KEYED OBJECT (the usual WL list shape) - iterate Object.values.
  const services = asRecord(asRecord(body)?.a_service);
  if (services === null) return [];

  const rows: ServiceCatalogueRow[] = [];
  for (const value of Object.values(services)) {
    const rec = asRecord(value);
    const kService = readString(rec, 'k_service');
    if (kService === null) continue; // no primary key, nothing we can store
    rows.push({
      k_service: kService,
      k_business: kBusiness,
      // s_service is the human title, e.g. "Music Private | Virtual | 45 Minutes".
      title: readString(rec, 's_service'),
      k_service_category: readString(rec, 'k_service_category'),
      // i_duration_real is the booked length in minutes (i_duration is 0 here).
      i_duration: readInt(rec, 'i_duration_real'),
      is_bookable: wlBool(rec?.is_bookable),
      is_resolved: true,
    });
  }
  return rows;
}

export interface WriteServicesInput {
  readonly kBusiness: string;
  /** The location this list was fetched for - the catalogue is per-location. */
  readonly kLocation: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export async function writeServiceList(
  db: SupabaseClient,
  input: WriteServicesInput,
): Promise<{ rawWlId: string; count: number }> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/appointment/book/service/list',
    targetKind: 'whole',
    targetKey: input.kLocation,
    runId: input.runId,
    response: input.response,
  });

  const rows = parseServiceList(input.response.body, input.kBusiness);
  if (rows.length > 0) {
    // k_service is the primary key: enriches the FK stub the purchase writer left
    // (and flips it to is_resolved = true) rather than duplicating it.
    await db.upsert('service', rows, { onConflict: 'k_service' });
    await linkRows(
      db,
      rawWlId,
      'service',
      rows.map((r) => r.k_service),
    );
  }
  return { rawWlId, count: rows.length };
}

// -----------------------------------------------------------------------------
// helpers (kept local so each writer file stands alone)
// -----------------------------------------------------------------------------

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

/** A small integer WL sends as a numeric string ("45") or a number. Null if neither. */
function readInt(rec: Record<string, unknown> | null, key: string): number | null {
  const v = rec?.[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}
