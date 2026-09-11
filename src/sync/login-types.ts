import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The login-type writer: /v1/login/type -> login_type rows.
 *
 * Business-wide, one call, no k_location. Probed live 24 Aug 2026: the body
 * carries `a_login_type_list`, a JSON ARRAY of thirteen records shaped like
 *   {"id_client_type":3,"is_member":1,"k_login_type":<quoted key>,
 *    "s_title":"Staff Client Profile","text_title":"Staff Client Profile"}
 * Thirteen is exactly the count the WL "All Clients" report offers as its
 * Client Types filter, so this table is that filter's vocabulary.
 *
 * WHY THIS MATTERS BEYOND REFERENCE DATA: `login_type.is_teacher_type` is what
 * defines a teacher (migration 0014). Without this pass that column has no rows
 * to sit on and the `teacher` view is empty - so this is not decoration, it is
 * the lookup royalty reporting depends on.
 *
 * NEVER CLOBBERS THE TEACHER FLAG. is_teacher_type is set by the studio, not by
 * WL, and WL has no opinion about it. It is deliberately absent from the upsert
 * payload so a re-sync refreshes titles and leaves the studio's decision alone -
 * a PostgREST upsert writes only the columns it is sent.
 *
 * `is_member` is nullable on purpose: WL sends null for the Prospect type, and
 * "not a member" is a different fact from "membership does not apply".
 */

export type LoginTypeRow = {
  readonly k_login_type: string;
  readonly k_business: string;
  readonly title: string | null;
  readonly id_client_type: number | null;
  readonly is_member: boolean | null;
};

export function parseLoginTypeList(body: unknown, kBusiness: string): LoginTypeRow[] {
  const rows = new Map<string, LoginTypeRow>();
  for (const value of collection(asRecord(body)?.a_login_type_list)) {
    const rec = asRecord(value);
    const kLoginType = readString(rec, 'k_login_type');
    if (kLoginType === null) continue; // no primary key, nothing we can store
    rows.set(kLoginType, {
      k_login_type: kLoginType,
      k_business: kBusiness,
      title: readString(rec, 'text_title') ?? readString(rec, 's_title'),
      id_client_type: readInt(rec?.id_client_type),
      is_member: readNullableBool(rec?.is_member),
    });
  }
  return [...rows.values()];
}

export interface WriteLoginTypesInput {
  readonly kBusiness: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export interface WriteLoginTypesResult {
  readonly rawWlId: string;
  readonly count: number;
}

export async function writeLoginTypeList(
  db: SupabaseClient,
  input: WriteLoginTypesInput,
): Promise<WriteLoginTypesResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/login/type',
    targetKind: 'whole',
    targetKey: 'all',
    runId: input.runId,
    response: input.response,
  });

  const rows = parseLoginTypeList(input.response.body, input.kBusiness);
  if (rows.length === 0) return { rawWlId, count: 0 };

  await db.upsert('login_type', rows, { onConflict: 'k_login_type' });
  await linkRows(
    db,
    rawWlId,
    'login_type',
    rows.map((r) => r.k_login_type),
  );

  return { rawWlId, count: rows.length };
}

/** WL sends this one as an ARRAY, but accept a keyed object too (see writer.ts). */
function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  return rec === null ? [] : Object.values(rec);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/**
 * WL sends 1 / 0 for member / not, and NULL for the Prospect type. Null is
 * preserved rather than folded to false - "membership does not apply" is not
 * the same statement as "not a member".
 */
function readNullableBool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') return null;
  return value === true || value === 1 || value === '1';
}
