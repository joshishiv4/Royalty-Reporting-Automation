import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl, wlDate } from './writer.js';

/**
 * The profile writer: /v1/user -> contact detail merged onto an existing person.
 *
 * This is the enrichment the staff writer deferred (see writer.ts: "email and
 * phone stay null until enrichment lands"). /v1/user is the ONLY place a client's
 * PRIMARY email appears - the client report exposes a secondary email only, which
 * is why GoHighLevel matching waits until after this runs (PRD 6.1). Probed live
 * 24 Aug 2026, recorded in WL-API-NOTES: the body is the record itself (not keyed),
 * with s_mail, s_first_name/s_last_name, s_phone/_home/_work, dt_birth, and the
 * login-type label.
 *
 * MERGE, NEVER CLOBBER: a value is written only when WL actually sent one. WL
 * returns "" for an absent phone and dt_birth; those are read as null and OMITTED
 * from the upsert payload, so a PostgREST upsert (which writes only the columns
 * present) leaves the existing value untouched rather than blanking it. uid and
 * k_business always anchor the row.
 *
 * IDEMPOTENT: upsert on uid updates the existing person row in place; re-running
 * enrichment for the same client refreshes, never duplicates.
 *
 * NOT stored here: gender and postal address (no person columns - out of 6.1's
 * scope; adding them is a migration, not a parser change).
 */

export type ProfileRow = {
  readonly uid: string;
  readonly k_business: string;
  readonly email?: string;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly phone?: string;
  readonly phone_home?: string;
  readonly phone_work?: string;
  readonly date_of_birth?: string;
  readonly k_login_type?: string;
  readonly text_login_type?: string;
};

/**
 * Parses a `/v1/user` body into a person patch. Only keys WL actually filled are
 * present, so the caller's upsert never blanks an existing value (see the header).
 */
export function parseProfile(body: unknown, uid: string, kBusiness: string): ProfileRow {
  const b = asRecord(body);
  const row: Record<string, string> & { uid: string; k_business: string } = {
    uid,
    k_business: kBusiness,
  };
  const put = (col: string, value: string | null): void => {
    if (value !== null) row[col] = value;
  };
  put('email', readString(b, 's_mail'));
  put('first_name', readString(b, 's_first_name'));
  put('last_name', readString(b, 's_last_name'));
  put('phone', readString(b, 's_phone'));
  put('phone_home', readString(b, 's_phone_home'));
  put('phone_work', readString(b, 's_phone_work'));
  // dt_birth is a bare date ("1989-11-14") or "" when unset; never a datetime.
  put('date_of_birth', wlDate(readString(b, 'dt_birth')));
  put('k_login_type', readString(b, 'k_login_type'));
  put('text_login_type', readString(b, 'text_login_type'));
  return row;
}

export interface WriteProfileInput {
  readonly kBusiness: string;
  readonly uid: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export interface WriteProfileResult {
  readonly rawWlId: string;
  /** True when the profile carried a primary email (the value GHL matching needs). */
  readonly hasEmail: boolean;
  /** How many person columns this call filled (beyond the uid/k_business anchor). */
  readonly fieldsFilled: number;
}

export async function writeProfile(
  db: SupabaseClient,
  input: WriteProfileInput,
): Promise<WriteProfileResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/user',
    targetKind: 'record',
    targetKey: input.uid,
    runId: input.runId,
    response: input.response,
  });

  const row = parseProfile(input.response.body, input.uid, input.kBusiness);
  // uid + k_business are always present; anything else is a filled field.
  const fieldsFilled = Object.keys(row).length - 2;

  await db.upsert('person', [row], { onConflict: 'uid' });
  await linkRows(db, rawWlId, 'person', [input.uid], 'profile');

  return { rawWlId, hasEmail: row.email !== undefined, fieldsFilled };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** WL sends "" for an absent field; read it as null so it is omitted, not stored. */
function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
