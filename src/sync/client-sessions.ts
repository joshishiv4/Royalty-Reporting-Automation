import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The per-client session writer: /v1/schedule/page/element -> session,
 * session_staff and attendance (PRD 7.2).
 *
 * WHY THIS EXISTS AT ALL. The business-wide schedule call returns CLASSES only.
 * Measured live 25 Aug 2026: it gave six occurrences of one class taught by one
 * person, while the per-client call gave 115 visits. Sixteen of the studio's
 * seventeen teachers had no session we could see, because they teach private
 * appointments and appointments are reachable ONLY per client. Private lessons
 * are the main revenue line, so without this pass almost no teaching is
 * attributable to anyone.
 *
 * FUTURE ONLY. THIS IS NOT A HISTORICAL LOAD, AND CANNOT BE MADE INTO ONE.
 * /v1/schedule/page/list returns upcoming visits and ignores date parameters
 * entirely - there is no window to widen. That is survivable for ongoing sync,
 * because a session is captured while it is still upcoming and its outcome is
 * filled in afterwards. It is NOT survivable for backfill: anything that already
 * happened before this pass first ran is simply not reachable here. The
 * historical load is a separate problem (P9). Do not assume this covers history.
 *
 * TWO SHAPES, TOLD APART BY WHICH KEY WL FILLS.
 *   appointment   k_appointment set, k_class_period null, k_service set
 *   class booking k_class_period set, k_appointment null, k_service null
 * Each gets its own key in session.k_period, which is what 0004 meant by "WL's
 * key for the SERIES ... named by session_kind". A class booking found here is
 * the same row the schedule pass writes, so the two converge instead of
 * duplicating.
 *
 * dt_cancel IS A DEADLINE, NOT A CANCELLATION. See migration 0017 - it was
 * exactly 24 hours before start on 40 of 40 visits measured, attended ones
 * included. It is stored as dt_cancel_by and must never be read as "cancelled".
 */

export type ClientSessionRow = {
  readonly k_period: string;
  readonly dt_start_utc: string;
  readonly k_business: string;
  readonly session_kind: 'class' | 'appointment';
  readonly k_class: string | null;
  readonly k_appointment: string | null;
  readonly k_service: string | null;
  readonly k_location: string | null;
  readonly dtl_start_local: string;
  readonly text_timezone: string | null;
  readonly text_title: string | null;
  readonly i_duration_min: number | null;
  readonly i_capacity: number | null;
  readonly is_event: boolean;
  readonly is_virtual: boolean;
  readonly is_checkin: boolean;
  readonly dt_cancel_by: string | null;
};

export type ParsedVisit = {
  readonly session: ClientSessionRow;
  readonly staff: ReadonlyArray<{ readonly k_staff: string; readonly s_name: string | null }>;
};

/**
 * Parses one visit-detail body. Returns null when WL sent neither key, which
 * cannot be stored: the session's identity IS that key.
 */
export function parseVisitElement(body: unknown, kBusiness: string): ParsedVisit | null {
  const b = asRecord(body);
  const kAppointment = readString(b, 'k_appointment');
  const kClassPeriod = readString(b, 'k_class_period');
  const dtStart = readString(b, 'dt_date_global');
  const dtlStart = readString(b, 'dt_date_local');
  if (dtStart === null || dtlStart === null) return null;

  // Appointment wins when both are somehow present: a private lesson is never a
  // class occurrence, and mis-filing one would put it on a shared key.
  const kPeriod = kAppointment ?? kClassPeriod;
  if (kPeriod === null) return null;
  const kind = kAppointment !== null ? 'appointment' : 'class';

  const staff: Array<{ k_staff: string; s_name: string | null }> = [];
  for (const value of collection(b?.a_staff)) {
    const rec = asRecord(value);
    const kStaff = readString(rec, 'k_staff');
    if (kStaff !== null) staff.push({ k_staff: kStaff, s_name: readString(rec, 's_name_full') });
  }

  return {
    session: {
      k_period: kPeriod,
      dt_start_utc: dtStart,
      k_business: kBusiness,
      session_kind: kind,
      k_class: kind === 'class' ? readString(b, 'k_class') : null,
      k_appointment: kAppointment,
      k_service: readString(b, 'k_service'),
      k_location: readString(b, 'k_location'),
      dtl_start_local: dtlStart,
      text_timezone: readString(b, 'text_timezone'),
      text_title: readString(b, 's_title'),
      i_duration_min: readInt(b?.i_duration),
      i_capacity: readInt(b?.i_capacity),
      is_event: wlBool(b?.is_event),
      is_virtual: wlBool(b?.is_virtual),
      is_checkin: wlBool(b?.is_checkin),
      // Named for what it is. See the header and migration 0017.
      dt_cancel_by: readString(b, 'dt_cancel'),
    },
    staff,
  };
}

/** The pointers /v1/schedule/page/list returns. Nothing else is on them. */
export function parseVisitList(body: unknown): string[] {
  const out = new Set<string>();
  for (const value of collection(asRecord(body)?.a_visit)) {
    const kVisit = readString(asRecord(value), 'k_visit');
    if (kVisit !== null) out.add(kVisit);
  }
  return [...out];
}

export interface WriteClientSessionInput {
  readonly kBusiness: string;
  /** The client whose list this visit came from - they are the attendee. */
  readonly uid: string;
  readonly kVisit: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export interface WriteClientSessionResult {
  readonly rawWlId: string;
  readonly written: boolean;
  readonly kind: 'class' | 'appointment' | null;
  readonly staffCount: number;
}

export async function writeClientSession(
  db: SupabaseClient,
  input: WriteClientSessionInput,
): Promise<WriteClientSessionResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/schedule/page/element',
    targetKind: 'record',
    targetKey: input.kVisit,
    runId: input.runId,
    response: input.response,
  });

  const parsed = parseVisitElement(input.response.body, input.kBusiness);
  if (parsed === null) return { rawWlId, written: false, kind: null, staffCount: 0 };

  const { session, staff } = parsed;

  // Stubs FIRST so the FKs resolve, same pattern as everywhere else.
  if (session.k_location !== null) {
    await db.upsert('location', [{ k_location: session.k_location, k_business: input.kBusiness }], {
      onConflict: 'k_location',
    });
  }
  if (session.k_service !== null) {
    await db.upsert('service', [{ k_service: session.k_service, k_business: input.kBusiness }], {
      onConflict: 'k_service',
    });
  }

  await db.upsert('session', [session], { onConflict: 'k_period,dt_start_utc' });
  await linkRows(db, rawWlId, 'session', [`${session.k_period}|${session.dt_start_utc}`], 'visit');

  if (staff.length > 0) {
    await db.upsert(
      'session_staff',
      staff.map((s) => ({
        k_period: session.k_period,
        dt_start_utc: session.dt_start_utc,
        k_staff: s.k_staff,
        // This endpoint gives k_staff and a name but NOT the staff member's uid,
        // unlike the schedule list. Left null rather than guessed at by name;
        // the schedule pass fills it for classes, and /v1/visit/status carries
        // uid_staff if it is ever needed for appointments.
        uid: null,
      })),
      { onConflict: 'k_period,dt_start_utc,k_staff' },
    );
  }

  // The client whose list produced this visit attended it. Without this the
  // session exists but nobody is attached, and an appointment has exactly one
  // attendee by definition.
  await db.upsert(
    'attendance',
    [
      {
        k_period: session.k_period,
        dt_start_utc: session.dt_start_utc,
        uid: input.uid,
        k_business: input.kBusiness,
        k_visit: input.kVisit,
        is_attended: session.is_checkin,
      },
    ],
    { onConflict: 'k_period,dt_start_utc,uid' },
  );

  return { rawWlId, written: true, kind: session.session_kind, staffCount: staff.length };
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

function readInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function wlBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
