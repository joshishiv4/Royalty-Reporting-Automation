import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The location writer: /v1/location/list -> location detail.
 *
 * The purchase writer only ever stubs a location (k_location + k_business) to
 * satisfy the FK. This fills in the real detail - title and timezone - from the
 * one endpoint that carries it. Probed live 21 Aug 2026: a record has `s_title`
 * and an `a_timezone` object whose `text_name` is the IANA zone
 * ("America/New_York"). Upserting on k_location enriches the stub in place; only
 * the columns sent are written, so it never clobbers a key the stub established.
 */

export type LocationRow = {
  readonly k_location: string;
  readonly k_business: string;
  readonly title: string | null;
  readonly text_timezone: string | null;
};

export function parseLocationList(body: unknown, kBusiness: string): LocationRow[] {
  const locations = asRecord(asRecord(body)?.a_location);
  if (locations === null) return [];

  const rows: LocationRow[] = [];
  for (const value of Object.values(locations)) {
    const rec = asRecord(value);
    const kLocation = readString(rec, 'k_location');
    if (kLocation === null) continue;
    rows.push({
      k_location: kLocation,
      k_business: kBusiness,
      title: readString(rec, 's_title'),
      // The IANA name is the useful one; the bare k_timezone is a key, not a zone.
      text_timezone: readString(asRecord(rec?.a_timezone), 'text_name'),
    });
  }
  return rows;
}

export interface WriteLocationsInput {
  readonly kBusiness: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export async function writeLocationList(
  db: SupabaseClient,
  input: WriteLocationsInput,
): Promise<{ rawWlId: string; count: number }> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/location/list',
    targetKind: 'whole',
    runId: input.runId,
    response: input.response,
  });

  const rows = parseLocationList(input.response.body, input.kBusiness);
  if (rows.length > 0) {
    await db.upsert('location', rows, { onConflict: 'k_location' });
    await linkRows(
      db,
      rawWlId,
      'location',
      rows.map((r) => r.k_location),
    );
  }
  return { rawWlId, count: rows.length };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
