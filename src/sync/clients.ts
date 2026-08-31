import type { SupabaseClient } from '../supabase/client.js';
import type { ReportPage } from '../wl/report.js';
import { WL_PATHS } from '../wl/endpoint.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The client list, from the reporting endpoint (PRD M07).
 *
 * THIS IS WHAT UNBLOCKS CLIENT ENUMERATION. Every other WL endpoint answers
 * about one client you already know the uid of; none of them lists clients. The
 * "Client List" report does, and it agrees with the portal exactly - 517
 * activated clients, and all twelve client-type totals matching tile for tile,
 * measured 26 Aug 2026.
 *
 * ROWS ARE POSITIONAL, AND THE POSITIONS ARE NOT OURS TO ASSUME.
 * `a_row` holds bare arrays; the column ids live separately in `a_field`. Worse,
 * several ids are business configuration - the `field-custom-*` columns are keyed
 * by ids meaningless outside this business, and the ORDER comes from how the
 * report is configured in the portal. (The observed ids are in
 * docs/WL-API-NOTES.md, not here: a business id sitting in source is exactly what
 * tests/no-hardcoded-config.test.ts exists to stop.)
 *
 * So every value is looked up by field NAME. Reading `row[5]` because
 * email is at index 5 today would silently write phone numbers into the email
 * column the first time somebody adds a column in the WL UI.
 *
 * WE DEPEND ON NO CUSTOM FIELD. Every column below is either top-level (`uid`,
 * `k_login_type`, `text_client_type`) or `field-general-*`, which are WL's own.
 * The business-specific `field-custom-*` columns are read by nothing here, so
 * reconfiguring them cannot break the sync.
 */

/**
 * Field id -> person column.
 *
 * The names look arbitrary because they are WL's, not ours. Each was confirmed
 * by joining 25 API rows against the portal's own CSV export of the same 25
 * clients and checking the values matched on all 25 - not by reading the name
 * and assuming.
 */
const FIELD_TO_COLUMN: Readonly<Record<string, string>> = {
  uid: 'uid',
  k_login_type: 'k_login_type',
  // The portal's "Client" column is these two joined, in this order.
  'field-general-2.text_name': 'first_name',
  'field-general-1': 'last_name',
  'field-general-3': 'email',
  'field-general-4': 'phone',
  'field-general-5': 'phone_home',
  'field-general-6': 'phone_work',
  'field-general-7.dl_date': 'date_of_birth',
  // The portal calls this "Member ID". It is NOT the uid - see DATA-MODEL.
  'field-general-11': 'text_member',
  text_client_type: 'text_login_type',
};

/** Columns that must never be overwritten with an absent value. */
const REQUIRED = 'uid';

/**
 * Refuses a page whose field list has stopped carrying something we map.
 *
 * WHY THIS HAS TO THROW. `mapClientRow` looks every value up by field id and
 * skips an id it does not recognise, which is right for the six
 * `field-custom-*` columns we deliberately ignore - but it means the reverse
 * failure is silent. If WL renames a field id, or a studio admin removes a
 * column from the report in the portal (the report IS portal-configured - see
 * the header), that column simply stops being written. Every client keeps its
 * stale value, the pass reports `ok`, and nothing anywhere says a field went
 * missing.
 *
 * Worse for `uid`: `mapClientRow` returns null without one, and `mapClientRows`
 * drops those rows - so losing the uid field id writes ZERO clients and still
 * reports success. That is the same shape as the queued-report bug in
 * wl/report.ts and the 1,000-row PostgREST cap in supabase/client.ts: the run
 * looks clean while the data is wrong. Both of those are defended against; this
 * was not.
 *
 * Measured before adding it, so this is a no-op today rather than a new
 * blocker: all 11 mapped ids are present on 20 of 20 stored report payloads
 * (31 Aug 2026), out of 37 ids the report returns.
 *
 * Deliberately strict. Phone is the PRIMARY GoHighLevel match key, so a
 * quietly-absent phone column degrades matching rather than breaking it, which
 * is far harder to notice than a failed run. Whoever reconfigured the report
 * should decide - not this parser.
 */
export function assertReportFields(fields: readonly string[]): void {
  const present = new Set(fields);
  const missing = Object.keys(FIELD_TO_COLUMN).filter((id) => !present.has(id));
  if (missing.length === 0) return;
  throw new Error(
    `WL client-list report is missing ${String(missing.length)} field id(s) this ` +
      `sync maps: ${missing.join(', ')}. The report is configured in the WL portal, ` +
      `so a removed or renamed column stops that person column being written ` +
      `without any other error. Refusing the page rather than storing clients ` +
      `with silently absent fields.`,
  );
}

export interface ClientRow {
  readonly uid: string;
  readonly [column: string]: unknown;
}

/**
 * Turns one positional row into a person patch.
 *
 * MERGE, NEVER CLOBBER. WL sends `""` for a field the client has not filled in,
 * and an empty string is not evidence that the value was deleted - it is the
 * absence of evidence. Anything empty is dropped from the patch entirely, so an
 * upsert leaves whatever another endpoint already established. This is why the
 * return type is sparse rather than a full person.
 *
 * Returns null when the row carries no uid: without one there is nobody to be.
 */
export function mapClientRow(fields: readonly string[], row: readonly unknown[]): ClientRow | null {
  const patch: Record<string, unknown> = {};

  for (let i = 0; i < fields.length; i += 1) {
    const column = FIELD_TO_COLUMN[fields[i] ?? ''];
    if (column === undefined) continue;
    const value = readText(row[i]);
    if (value === null) continue;
    patch[column] = value;
  }

  const uid = patch[REQUIRED];
  if (typeof uid !== 'string' || uid.length === 0) return null;
  return patch as ClientRow;
}

/** Every mappable row, with the unusable ones dropped rather than guessed at. */
export function mapClientRows(
  fields: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): readonly ClientRow[] {
  const seen = new Set<string>();
  const out: ClientRow[] = [];
  for (const row of rows) {
    const mapped = mapClientRow(fields, row);
    if (mapped === null) continue;
    // One human is one person row. A uid appearing twice in one report would
    // make the upsert fight itself; the first wins and the duplicate is dropped.
    if (seen.has(mapped.uid)) continue;
    seen.add(mapped.uid);
    out.push(mapped);
  }
  return out;
}

export interface WriteClientListInput {
  readonly kBusiness: string;
  readonly runId: string;
  readonly page: ReportPage;
  readonly fields: readonly string[];
  readonly syncedAt: string;
  /**
   * The uids WL lists as ACTIVATED (o_member_status 3). Every client in this
   * page whose uid is in the set is stored `is_active = true`, the rest false.
   * The report row carries no status field (only a type label), so activation is
   * known only by membership of the activated result - see migration 0027.
   */
  readonly activatedUids: ReadonlySet<string>;
}

/**
 * Stores one page: the payload verbatim, then the people, then the link.
 *
 * `field_group` is 'identity' rather than 'all': this report establishes who
 * somebody is, and nothing about their money or their bookings. A person row
 * assembled from this report and a purchase payload can then trace each half to
 * where it came from.
 */
export async function writeClientList(
  db: SupabaseClient,
  input: WriteClientListInput,
): Promise<{ rawWlId: string; clients: readonly ClientRow[] }> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: WL_PATHS.reportQuery,
    targetKind: 'page',
    runId: input.runId,
    response: input.page.response,
  });

  // AFTER the raw store, deliberately: if the shape has changed, the payload
  // that proves it is already in raw_wl to be read without another WL call.
  assertReportFields(input.fields);

  const clients = mapClientRows(input.fields, input.page.rows);
  if (clients.length > 0) {
    const rows = clients.map((c) => ({
      ...c,
      k_business: input.kBusiness,
      // Always known from the report split (true/false), never absent - so it is
      // safe against merge-never-clobber and every row carries it.
      is_active: input.activatedUids.has(c.uid),
      synced_at: input.syncedAt,
    }));
    for (const batch of groupByShape(rows)) {
      await db.upsert('person', batch, { onConflict: 'uid' });
    }
    await linkRows(
      db,
      rawWlId,
      'person',
      clients.map((c) => c.uid),
      'identity',
    );
  }

  return { rawWlId, clients };
}

/**
 * WL's absent value is `""`, sometimes `null`, and for a few fields `0`.
 *
 * Only empty string and null are treated as absent here. A `0` is left alone
 * because none of the columns above is numeric - turning "0" into null would be
 * inventing a rule this report does not need.
 */
function readText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Splits rows into batches that share exactly the same set of keys.
 *
 * PostgREST rejects a bulk write whose objects differ in shape - `PGRST102: All
 * object keys must match` - because it builds one INSERT from the first object's
 * columns. That collides head-on with merge-never-clobber, which produces
 * deliberately sparse rows: a client with no work phone simply has no
 * `phone_work` key.
 *
 * The two obvious ways out are both wrong. Filling the gaps with null is exactly
 * the clobber the sparseness exists to prevent - it would erase values other
 * endpoints established. Writing one row per request turns 517 clients into 517
 * round trips.
 *
 * Grouping by shape keeps both properties. Measured on the live business, 517
 * activated clients fall into a manageable number of shapes, so the whole list
 * still goes in a handful of calls.
 */
export function groupByShape<T extends Record<string, unknown>>(
  rows: readonly T[],
): ReadonlyArray<readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const shape = Object.keys(row).sort().join(',');
    const existing = groups.get(shape);
    if (existing === undefined) groups.set(shape, [row]);
    else existing.push(row);
  }
  return [...groups.values()];
}
