import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The attendance writer: /v1/login/attendance/list -> attendance rows.
 *
 * THE PARAMETER THAT UNBLOCKED THIS. The endpoint was recorded as a blocker for
 * days, rejecting every date with `date-incorrect`. The date was never the
 * problem - the parameter NAME was. It is `dt_date_local`, not `dt_date`, and it
 * wants the occurrence's LOCAL start time (`YYYY-MM-DD HH:MM:SS`) together with
 * `k_class_period`. Probed live 25 Aug 2026: `dt_date` is rejected, a bare date
 * is rejected, and the session's global time answers with an empty list. Only the
 * local time returns anything.
 *
 * THREE LISTS, NOT ONE. WL splits attendees into a_list_active (booked),
 * a_list_confirm (confirmed) and a_list_wait (queued for a place). Someone on
 * the waiting list is NOT attending, so they are flagged rather than folded in -
 * see migration 0016.
 *
 * THE PERSON MAY BE A STRANGER. Attendees are ordinary clients, and the client
 * base cannot be enumerated (STATUS blocker 1). Live, both attendees of every
 * session were people we do not otherwise hold. attendance.uid is NOT NULL with
 * a real FK, so a person stub is written first - the same stub-don't-fail
 * pattern locations, services and recipients use.
 */

export type AttendanceRow = {
  readonly k_period: string;
  readonly dt_start_utc: string;
  readonly uid: string;
  readonly k_business: string;
  readonly k_visit: string | null;
  readonly dt_booked_utc: string | null;
  readonly is_attended: boolean;
  readonly is_no_show: boolean;
  readonly is_waitlisted: boolean;
  readonly is_unpaid: boolean;
  readonly uid_book: string | null;
};

export interface ParsedAttendance {
  readonly rows: readonly AttendanceRow[];
  /** Distinct attendee uids, for the person stub upsert (the FK needs them). */
  readonly uids: readonly string[];
  /** Entries WL returned with no uid, which cannot be keyed. */
  readonly skipped: number;
}

export function parseAttendanceList(
  body: unknown,
  kPeriod: string,
  dtStartUtc: string,
  kBusiness: string,
): ParsedAttendance {
  const b = asRecord(body);
  const rows = new Map<string, AttendanceRow>();
  const uids = new Set<string>();
  let skipped = 0;

  const take = (listKey: string, isWaitlisted: boolean): void => {
    for (const value of collection(b?.[listKey])) {
      const rec = asRecord(value);
      const uid = readString(rec, 'uid');
      if (uid === null) {
        skipped += 1;
        continue;
      }
      uids.add(uid);
      rows.set(uid, {
        k_period: kPeriod,
        dt_start_utc: dtStartUtc,
        uid,
        k_business: kBusiness,
        k_visit: readString(rec, 'k_visit'),
        dt_booked_utc: readString(rec, 'dt_book'),
        // WL sends both; is_visit is the one populated on every record observed.
        is_attended: wlBool(rec?.is_visit) || wlBool(rec?.is_attend),
        // WL's word for a no-show.
        is_no_show: wlBool(rec?.is_truancy),
        is_waitlisted: isWaitlisted,
        is_unpaid: wlBool(rec?.is_unpaid),
        uid_book: readString(rec, 'uid_book'),
      });
    }
  };

  // Order matters: a person appearing on both lists is booked, not waiting, so
  // the active/confirmed entry must be the one that survives.
  take('a_list_wait', true);
  take('a_list_confirm', false);
  take('a_list_active', false);

  return { rows: [...rows.values()], uids: [...uids], skipped };
}

export interface WriteAttendanceInput {
  readonly kBusiness: string;
  readonly kPeriod: string;
  readonly dtStartUtc: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export interface WriteAttendanceResult {
  readonly rawWlId: string;
  readonly count: number;
  readonly attended: number;
  readonly skipped: number;
}

export async function writeAttendanceList(
  db: SupabaseClient,
  input: WriteAttendanceInput,
): Promise<WriteAttendanceResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/login/attendance/list',
    targetKind: 'record',
    // Same composite convention as sync_queue and raw_link.
    targetKey: `${input.kPeriod}|${input.dtStartUtc}`,
    runId: input.runId,
    response: input.response,
  });

  const { rows, uids, skipped } = parseAttendanceList(
    input.response.body,
    input.kPeriod,
    input.dtStartUtc,
    input.kBusiness,
  );
  if (rows.length === 0) return { rawWlId, count: 0, attended: 0, skipped };

  // Stub FIRST: attendance.uid is NOT NULL and references person. See header.
  await db.upsert(
    'person',
    uids.map((uid) => ({ uid, k_business: input.kBusiness })),
    { onConflict: 'uid' },
  );

  await db.upsert('attendance', rows, { onConflict: 'k_period,dt_start_utc,uid' });
  await linkRows(
    db,
    rawWlId,
    'attendance',
    rows.map((r) => `${r.k_period}|${r.dt_start_utc}|${r.uid}`),
  );

  return {
    rawWlId,
    count: rows.length,
    attended: rows.filter((r) => r.is_attended).length,
    skipped,
  };
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
  if (typeof v === 'string' && v.length > 0) return v;
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}

function wlBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
