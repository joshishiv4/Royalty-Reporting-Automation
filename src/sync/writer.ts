import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';

/**
 * The writer: WL response -> raw_wl -> typed rows -> raw_link.
 *
 * This is the M03a slice (staff -> person). Every typed row is stored ALONGSIDE
 * the raw payload it came from, linked through raw_link, so any value in the
 * database can be traced back to exactly what WL sent. The raw store is written
 * first and unconditionally: if a parser is wrong, the payload is still on disk
 * to reparse, which a discarded response never is.
 *
 * NOT in this slice: purchases (they need location and a payer person row first -
 * FK ordering that is its own task), and /v1/user enrichment of staff contact
 * details. Staff arrive from /v1/staff/list with uid, keys and names; email and
 * phone stay null until enrichment lands.
 */

/**
 * A row for the `person` table, as parsed from a staff record.
 *
 * A `type`, not an `interface`, so it is assignable to the client's
 * `Record<string, unknown>` row input - an interface has no implicit index
 * signature and would need a cast at every call site.
 */
export type PersonRow = {
  readonly uid: string;
  readonly k_business: string;
  readonly k_staff: string | null;
  readonly is_class: boolean;
  readonly is_appointment: boolean;
  readonly is_event: boolean;
  readonly first_name: string | null;
  readonly last_name: string | null;
};

export interface WriteStaffInput {
  readonly kBusiness: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export interface WriteStaffResult {
  readonly rawWlId: string;
  readonly persons: readonly PersonRow[];
}

/**
 * Parses a `/v1/staff/list` body into person rows.
 *
 * WL list endpoints return a keyed object, not an array (a CLAUDE.md trap), so
 * this iterates `Object.values`. All WL keys are text and are kept as text - a
 * uid with a leading zero loses it as a number.
 */
export function parseStaffList(body: unknown, kBusiness: string): PersonRow[] {
  const staff = asRecord(asRecord(body)?.a_staff);
  if (staff === null) return [];

  const rows: PersonRow[] = [];
  for (const value of Object.values(staff)) {
    const rec = asRecord(value);
    const uid = readString(rec, 'uid');
    if (uid === null) continue; // no primary key, nothing we can store
    rows.push({
      uid,
      k_business: kBusiness,
      k_staff: readString(rec, 'k_staff'),
      is_class: wlBool(rec?.is_class),
      is_appointment: wlBool(rec?.is_appointment),
      is_event: wlBool(rec?.is_event),
      first_name: readString(rec, 's_name'),
      last_name: readString(rec, 's_surname'),
    });
  }
  return rows;
}

/**
 * Stores staff from an already-fetched response: raw payload, then person rows,
 * then the links between them. The fetch is the caller's job so this stays
 * testable without a network.
 */
export async function writeStaffList(
  db: SupabaseClient,
  input: WriteStaffInput,
): Promise<WriteStaffResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/staff/list',
    targetKind: 'whole',
    runId: input.runId,
    response: input.response,
  });

  const persons = parseStaffList(input.response.body, input.kBusiness);
  if (persons.length > 0) {
    // uid is the primary key: re-running updates in place, never duplicates.
    await db.upsert('person', persons, { onConflict: 'uid' });
    await linkRows(
      db,
      rawWlId,
      'person',
      persons.map((p) => p.uid),
    );
  }

  return { rawWlId, persons };
}

interface StoreRawInput {
  readonly kBusiness: string;
  readonly sourceEndpoint: string;
  readonly targetKind: 'record' | 'page' | 'whole';
  readonly runId: string;
  readonly response: WlResponse<unknown>;
  readonly targetKey?: string;
}

/** Inserts the raw payload and returns its id, for raw_link to point at. */
export async function storeRawWl(db: SupabaseClient, input: StoreRawInput): Promise<string> {
  const rows = await db.insert<{ id: string }>('raw_wl', [
    {
      k_business: input.kBusiness,
      source_endpoint: input.sourceEndpoint,
      target_kind: input.targetKind,
      ...(input.targetKey === undefined ? {} : { target_key: input.targetKey }),
      payload: input.response.body,
      http_status: input.response.httpStatus,
      wl_status: 'ok',
      trace_id: input.response.traceId,
      k_log: input.response.kLog,
      run_id: input.runId,
      latency_ms: input.response.latencyMs,
    },
  ]);
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('raw_wl insert returned no id - cannot link typed rows to their payload');
  }
  return id;
}

/**
 * One raw_link row per typed row, tying it to the payload it was parsed from.
 *
 * `fieldGroup` records WHICH fields came from this payload: the structure writer
 * uses 'all', the receipt writer 'money', so a row assembled from two payloads
 * traces each part to its source.
 */
export async function linkRows(
  db: SupabaseClient,
  rawWlId: string,
  tableName: string,
  recordKeys: readonly string[],
  fieldGroup = 'all',
): Promise<void> {
  if (recordKeys.length === 0) return;
  await db.insert(
    'raw_link',
    recordKeys.map((record_key) => ({
      raw_wl_id: rawWlId,
      table_name: tableName,
      record_key,
      field_group: fieldGroup,
    })),
  );
}

/**
 * WL's booleans arrive as `true`, `1`, or `"1"` depending on the endpoint.
 * Anything else - `false`, `0`, `"0"`, absent - is false.
 */
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

/**
 * A WellnessLiving date, with their "not set" spelled as absent.
 *
 * WL SENDS MySQL'S ZERO DATE FOR AN EMPTY DATE, and Postgres refuses it:
 *
 *   SupabaseError: 22008: date/time field value out of range: "0000-00-00 00:00:00"
 *
 * Their own spec says so in as many words - `dt_confirm` "will be zero date +
 * time in case appointment is not yet confirmed by client" - so this is
 * documented behaviour, not an anomaly. It went unguarded in all six writers
 * because the endpoints read until now happened never to send one; the first
 * appointment attendance records did, and the pass died on every batch.
 *
 * Null, not the epoch. "Never checked in" is the absence of a check-in, and
 * 1970-01-01 is a claim about January 1970.
 */
export function wlDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Any zero date, with or without a time, and the all-zero variant WL also uses.
  if (/^0{4}-0{2}-0{2}/.test(trimmed)) return null;
  return trimmed;
}
