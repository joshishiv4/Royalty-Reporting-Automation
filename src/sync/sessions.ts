import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The session writer: /v1/schedule/class/list -> session + session_staff.
 *
 * THE TRAP THIS EXISTS AROUND. A class id repeats every week. Probed live
 * 25 Aug 2026, ONE k_class_period came back SIX times in one 38-day window -
 * same id, six different dates. Keyed on the id alone, five occurrences would
 * overwrite each other and the studio would be paid for one class instead of six.
 * The key is (k_period, dt_start_utc), set in migration 0004.
 *
 * BUSINESS-WIDE, DESPITE NEEDING A uid. The endpoint requires a `uid` but the
 * schedule it returns is the business's, not that person's: four different uids
 * were probed and all four returned the identical seven sessions. So one call
 * covers the whole studio and the cost does not grow with the client base. The
 * uid is context, not a filter.
 *
 * DATE FORMAT IS THE EXCEPTION TO THE HOUSE RULE. Everywhere else in WL a date
 * needs a time component. Here `dt_date` and `dt_end` must be BARE DATES
 * (YYYY-MM-DD) - sending "2026-08-18 00:00:00" is rejected with
 * `date-end-invalid`. This cost a day of guessing; the Postman collection
 * documents it and the collection is right.
 *
 * LOCAL TIME IS STORED AS SENT, NEVER DERIVED. WL returns dt_date (global) and
 * dtl_date (local) side by side, plus its own timezone label. Recomputing the
 * local value from the UTC one would silently disagree with WL across a DST
 * boundary, and WL's is the one the studio sees.
 */

export type SessionRow = {
  readonly k_period: string;
  readonly dt_start_utc: string;
  readonly k_business: string;
  readonly session_kind: 'class';
  readonly k_class: string | null;
  readonly k_location: string | null;
  readonly dtl_start_local: string;
  readonly text_timezone: string | null;
  readonly text_title: string | null;
  readonly i_duration_min: number | null;
  readonly i_capacity: number | null;
  readonly i_booked: number | null;
  readonly i_wait: number | null;
  readonly is_event: boolean;
  readonly is_virtual: boolean;
  readonly is_wait_list_enabled: boolean;
  readonly is_cancelled_studio: boolean;
  readonly url_book: string | null;
};

export type SessionStaffRow = {
  readonly k_period: string;
  readonly dt_start_utc: string;
  readonly k_staff: string;
  readonly uid: string | null;
};

export interface ParsedSessions {
  readonly sessions: readonly SessionRow[];
  readonly staff: readonly SessionStaffRow[];
  /** Distinct non-null k_location values, for the location stub upsert. */
  readonly locationKeys: readonly string[];
  /** Distinct staff uids, for the person stub upsert (the FK needs them). */
  readonly staffUids: readonly string[];
  /** Records WL returned that carried no class period, so could not be keyed. */
  readonly skipped: number;
}

/**
 * Parses `a_session` into occurrences and their staff.
 *
 * WL mixes a malformed record into the list - one entry observed live carried a
 * dtl_date and nothing else: no k_class_period, no capacity, no staff. It cannot
 * be keyed, so it is counted and skipped rather than stored as a half-row.
 */
export function parseSessionList(body: unknown, kBusiness: string): ParsedSessions {
  const sessions = new Map<string, SessionRow>();
  const staff = new Map<string, SessionStaffRow>();
  const locationKeys = new Set<string>();
  const staffUids = new Set<string>();
  let skipped = 0;

  for (const value of collection(asRecord(body)?.a_session)) {
    const rec = asRecord(value);
    const kPeriod = readString(rec, 'k_class_period');
    const dtStart = readString(rec, 'dt_date');
    const dtlStart = readString(rec, 'dtl_date');
    if (kPeriod === null || dtStart === null || dtlStart === null) {
      skipped += 1;
      continue;
    }

    const kLocation = readString(rec, 'k_location');
    if (kLocation !== null) locationKeys.add(kLocation);

    // Composite key, joined the same way sync_queue and raw_link join theirs.
    const key = `${kPeriod}|${dtStart}`;
    sessions.set(key, {
      k_period: kPeriod,
      dt_start_utc: dtStart,
      k_business: kBusiness,
      session_kind: 'class',
      k_class: readString(rec, 'k_class'),
      k_location: kLocation,
      dtl_start_local: dtlStart,
      text_timezone: readString(rec, 'text_timezone'),
      text_title: readString(rec, 's_title'),
      i_duration_min: readInt(rec?.i_duration),
      i_capacity: readInt(rec?.i_capacity),
      i_booked: readInt(rec?.i_book),
      i_wait: readInt(rec?.i_wait),
      is_event: wlBool(rec?.is_event),
      is_virtual: wlBool(rec?.is_virtual),
      is_wait_list_enabled: wlBool(rec?.is_wait_list_enabled),
      // WL gives ONE cancellation flag; the schema deliberately keeps two,
      // because a studio pulling a class and a client dropping out have
      // different royalty consequences (0004). A cancellation on the schedule
      // is the studio's. The per-client half stays at its default: attendance
      // populates now, but WL reports no cancellation there either - and the
      // detail endpoint's dt_cancel is a DEADLINE, not a cancellation (0017).
      // Nothing WL returns fills it. See WL-API-NOTES.
      is_cancelled_studio: wlBool(rec?.is_cancel),
      url_book: readString(rec, 'url_book'),
    });

    // a_staff holds k_staff, a_staff_uid the person uid, positionally paired.
    const kStaffList = collection(rec?.a_staff).map(readText).filter(nonEmpty);
    const uidList = collection(rec?.a_staff_uid).map(readText).filter(nonEmpty);
    kStaffList.forEach((kStaff, i) => {
      const uid = uidList[i] ?? null;
      if (uid !== null) staffUids.add(uid);
      staff.set(`${key}|${kStaff}`, {
        k_period: kPeriod,
        dt_start_utc: dtStart,
        k_staff: kStaff,
        uid,
      });
    });
  }

  return {
    sessions: [...sessions.values()],
    staff: [...staff.values()],
    locationKeys: [...locationKeys],
    staffUids: [...staffUids],
    skipped,
  };
}

export interface WriteSessionsInput {
  readonly kBusiness: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
  /** The window fetched, for the raw record's target key. */
  readonly windowKey: string;
}

export interface WriteSessionsResult {
  readonly rawWlId: string;
  readonly sessionCount: number;
  readonly staffCount: number;
  readonly skipped: number;
}

export async function writeSessionList(
  db: SupabaseClient,
  input: WriteSessionsInput,
): Promise<WriteSessionsResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/schedule/class/list',
    targetKind: 'page',
    targetKey: input.windowKey,
    runId: input.runId,
    response: input.response,
  });

  const { sessions, staff, locationKeys, staffUids, skipped } = parseSessionList(
    input.response.body,
    input.kBusiness,
  );
  if (sessions.length === 0) {
    return { rawWlId, sessionCount: 0, staffCount: 0, skipped };
  }

  // Stubs FIRST so the FKs resolve. Only the key and k_business are sent, so an
  // already-enriched row keeps everything else - a PostgREST upsert writes only
  // the columns in the payload.
  if (locationKeys.length > 0) {
    await db.upsert(
      'location',
      locationKeys.map((k_location) => ({ k_location, k_business: input.kBusiness })),
      { onConflict: 'k_location' },
    );
  }
  if (staffUids.length > 0) {
    await db.upsert(
      'person',
      staffUids.map((uid) => ({ uid, k_business: input.kBusiness })),
      { onConflict: 'uid' },
    );
  }

  await db.upsert('session', sessions, { onConflict: 'k_period,dt_start_utc' });
  await linkRows(
    db,
    rawWlId,
    'session',
    sessions.map((s) => `${s.k_period}|${s.dt_start_utc}`),
  );

  if (staff.length > 0) {
    await db.upsert('session_staff', staff, { onConflict: 'k_period,dt_start_utc,k_staff' });
  }

  return { rawWlId, sessionCount: sessions.length, staffCount: staff.length, skipped };
}

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

/** A list entry that may be a string or a number; WL mixes both for keys. */
function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

function readInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** WL sends these as the STRINGS "0" / "1" on this endpoint, not as booleans. */
function wlBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
