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
 * HISTORY IS REACHABLE. `is_past` DOES IT. THE OPPOSITE USED TO BE WRITTEN HERE.
 *
 * This comment said "future only, and cannot be made into one - the endpoint
 * ignores date parameters, there is no window to widen". That was wrong, and
 * wrong in the expensive direction: it closed off a solution and pushed the
 * historical load into a separate blocked task.
 *
 * What was actually true is narrower. The pass sends only `{ uid }`, and in that
 * shape the endpoint answers with upcoming visits. It also accepts:
 *
 *   is_past=1               all of the client's PREVIOUS visits
 *   dtu_start / dtu_end     a window - note dtu_, not dt_
 *
 * Measured live 27 Aug 2026, same uid, same endpoint:
 *
 *   { uid }                                  ->   0 visits
 *   { uid, is_past: 1 }                      -> 402 visits, 2021-01-30 .. 2025-02-20
 *   { uid, dtu_start, dtu_end } (2025)       ->   0 visits   (no is_past: future list)
 *   { uid, is_past, dtu_start, dtu_end }     ->   3 visits   (the window NARROWS)
 *
 * So the dates are not ignored either - they were being sent under the wrong
 * names, and without the flag that selects the past half.
 *
 * AND is_past ALONE IS COMPLETE. Widening the window to 1990-01-01 .. 2030-12-31
 * returned the same 402 rows over the same range, and dropping the window
 * entirely returned them too. 402 is not a page and not a cap - it is everything
 * WL holds for that client. A historical backfill therefore needs NO date paging
 * at all: one call per client with is_past=1.
 *
 * Sampled across ten clients: 10.6 past visits each, half with none, which puts
 * a full historical backfill at roughly 13,600 element calls - under an hour.
 *
 * This pass still runs FORWARD ONLY, deliberately - ongoing sync wants upcoming
 * sessions so a visit is caught before it happens and finalised by the 7.3
 * re-read. The historical load remains P9's job. What has changed is that P9 is
 * no longer blocked on WellnessLiving: it is one parameter.
 *
 * TWO SHAPES, TOLD APART BY WHICH KEY WL FILLS.
 *   appointment   k_appointment set, k_class_period null, k_service set
 *   class booking k_class_period set, k_appointment null, k_service null
 * Each gets its own key in session.k_period, which is what 0004 meant by "WL's
 * key for the SERIES ... named by session_kind". A class booking found here is
 * the same row the schedule pass writes, so the two converge instead of
 * duplicating.
 *
 * BOOKING-REQUEST STATE (PRD 7.5) is nested under a_appointment_visit_info:
 * is_request, is_confirmed and is_deny. A request is a PROPOSAL, not work, and
 * must not earn a royalty.
 *
 * is_confirmed IS STORED BUT IS NOT A GATE, and that distinction matters. It is
 * FALSE on 60 of 60 payloads measured. Read as "not confirmed" it would exclude
 * every session in the business and royalties would come to zero. is_request is
 * false on all 60 too, which says this studio has no request flow at all - so
 * is_confirmed is simply not meaningful here. Exclusion is driven by is_request
 * and is_deny, which mean something on their own.
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
  /**
   * WL's own verdict on the visit (WlVisitSid) - 3 ATTEND, 4 PENALTY,
   * 5 TRUANCY, 6 CANCEL, 7 PENDING, 1 BOOK, 2 WAIT, 8 REMOVE.
   *
   * THE ONLY FIELD THAT SAYS WHAT HAPPENED. is_checkin does not: the API
   * documents it as "ready to be checked in", a capability, and it was true on
   * 0 of 4,423 sessions on live dev. Reading it as attendance left the royalty
   * signal empty - see migration 0029.
   */
  readonly id_visit: string | null;
  // Booking-request state (PRD 7.5). See the header for why is_confirmed is
  // stored but never used as a gate.
  readonly is_request: boolean;
  readonly is_confirmed: boolean;
  readonly is_denied: boolean;
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

  const visitInfo = asRecord(b?.a_appointment_visit_info);

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
      // READ FROM BOTH LEVELS. Measured over 200 stored page/element payloads:
      // id_visit arrives at the top level AND inside a_appointment_visit_info,
      // 200 of 200 each, so either position alone would have worked on real
      // data. The fixture in tests/sync-client-sessions.ts carries only the
      // nested one, which is why that is tried first - but neither is a
      // fallback for a broken API, they are two places WL fills.
      //
      // (An earlier version of this comment claimed the docs put it in the
      // wrong place. They do not; that was our misreading of a partial fixture.)
      //
      // Text, not a number: it is WL's code, and an integer invites arithmetic
      // on it. WL sends it as a number in JSON, so it is normalised here.
      id_visit: readCode(visitInfo?.id_visit) ?? readCode(b?.id_visit),
      // WL nests these under a_appointment_visit_info, not at the top level.
      is_request: wlBool(visitInfo?.is_request),
      is_confirmed: wlBool(visitInfo?.is_confirmed),
      is_denied: wlBool(visitInfo?.is_deny),
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
  /** New fetch count for this session (PRD 7.3). Omitted leaves it untouched. */
  readonly detailFetchCount?: number;
  /** When this read happened, as an ISO string. Required alongside the count. */
  readonly fetchedAt?: string;
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

  // The detail counter rides on the same upsert (PRD 7.3). It is passed in
  // rather than incremented here, because "how many times has this been read"
  // is the caller's knowledge - the writer sees one payload and cannot count.
  await db.upsert(
    'session',
    [
      {
        ...session,
        ...(input.detailFetchCount === undefined
          ? {}
          : { detail_fetch_count: input.detailFetchCount, detail_fetched_at: input.fetchedAt }),
      },
    ],
    { onConflict: 'k_period,dt_start_utc' },
  );
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
        ...visitOutcome(session.id_visit),
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

/**
 * Turns WL's visit status into the outcome columns.
 *
 * ONE PLACE, and it must agree with migration 0029's backfill - the same
 * mapping is applied there so a re-parse and a fresh sync cannot disagree.
 *
 * is_attended is NULL for anything without a verdict. That is the whole point:
 * `false` would claim the client did not turn up, and for BOOK, WAIT, PENDING or
 * a status WL has not filled in yet, we simply do not know. It is the column a
 * royalty is calculated from, so it may not guess.
 *
 * A status we have never seen also lands as unknown rather than as "not
 * attended" - WL may add one, and a new code must not silently read as absence.
 *
 * Exported so the mapping is testable on a literal rather than only through a
 * fake database. It decides what a royalty is paid on; it should not be
 * reachable only by simulating a sync.
 */
export function visitOutcome(idVisit: string | null): {
  id_visit: string | null;
  is_attended: boolean | null;
  is_no_show: boolean;
  is_cancelled_client: boolean;
  is_late_cancel: boolean;
} {
  const unknown = {
    id_visit: idVisit,
    is_attended: null,
    is_no_show: false,
    is_cancelled_client: false,
    is_late_cancel: false,
  };

  switch (idVisit) {
    case '3': // ATTEND - client has attended the session
      return { ...unknown, is_attended: true };
    case '5': // TRUANCY - missed it, without cancelling
      return { ...unknown, is_attended: false, is_no_show: true };
    case '6': // CANCEL - cancelled in time, no penalty
      return { ...unknown, is_attended: false, is_cancelled_client: true };
    case '4': // PENALTY - cancelled too late. Still a cancellation, and late.
      return { ...unknown, is_attended: false, is_cancelled_client: true, is_late_cancel: true };
    case '1': // BOOK  - reserved, has not happened
    case '2': // WAIT  - on the wait list
    case '7': // PENDING - WL is waiting for staff to decide
    case '8': // REMOVE  - hidden in WL, retained in their database
    default:
      return unknown;
  }
}

/**
 * Reads a WL code as text.
 *
 * WL sends id_visit as a JSON number; every other WL key in this schema is text
 * because a leading zero is lost as an integer, and because a code should not be
 * arithmetic. Zero is not a valid WlVisitSid value, so a falsy number is treated
 * as absent rather than as `"0"`.
 */
function readCode(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return String(value);
  if (typeof value === 'string' && value.length > 0 && value !== '0') return value;
  return null;
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
