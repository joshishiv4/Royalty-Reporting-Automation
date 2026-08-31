import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';
import { readVisitCode, visitOutcome } from './visit-outcome.js';

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
      id_visit: readVisitCode(visitInfo?.id_visit) ?? readVisitCode(b?.id_visit),
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
  /**
   * Keys already stubbed during THIS pass, so a location or service is written
   * once rather than once per visit. Owned by the caller and discarded with the
   * pass; omit it and every visit stubs again, which is correct but slower.
   */
  readonly stubbed?: Set<string>;
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

  // Stubs FIRST so the FKs resolve, same pattern as everywhere else - but at most
  // ONCE PER KEY PER PASS.
  //
  // These were re-upserted on every visit, and a client's whole history shares a
  // handful of locations and services: measured on the 1980 backfill, one studio
  // location and 75 services across ~9,000 visits. Two of the seven sequential
  // round trips each visit costs were therefore writing rows that already
  // existed. At ~460ms of Supabase latency per trip that is most of a second per
  // visit, which over 39,000 visits is hours.
  //
  // The cache is the CALLER'S, not a module-level one: it must live exactly as
  // long as a pass, or a long-running process would remember a stub it made
  // before someone truncated the table.
  const stubbed = input.stubbed;
  const stub = async (table: string, column: string, key: string): Promise<void> => {
    const marker = `${table}:${key}`;
    if (stubbed?.has(marker) === true) return;
    await db.upsert(table, [{ [column]: key, k_business: input.kBusiness }], {
      onConflict: column,
    });
    stubbed?.add(marker);
  };
  if (session.k_location !== null) await stub('location', 'k_location', session.k_location);
  if (session.k_service !== null) await stub('service', 'k_service', session.k_service);

  // id_visit IS NOT A SESSION COLUMN, and spreading it into this upsert broke the
  // whole pass silently for days.
  //
  // It is WL's verdict on ONE CLIENT'S visit, so migration 0029 put it on
  // `attendance`. It rides on the parsed session only because this payload is
  // where it arrives and the attendance write below needs it. Sending it here
  // earns `PGRST204: Could not find the 'id_visit' column of 'session'`, which
  // fails the item, fails the pass, and looks from the outside like a partial
  // run - so `session` sat at 4,423 rows while raw_wl kept growing.
  //
  // Destructured rather than deleted: the compiler now refuses to let a new
  // carrier field reach this table by accident.
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- the point IS to
     drop it: destructuring is what keeps it out of the row below. */
  const { id_visit: _idVisit, ...sessionRow } = session;

  // The detail counter rides on the same upsert (PRD 7.3). It is passed in
  // rather than incremented here, because "how many times has this been read"
  // is the caller's knowledge - the writer sees one payload and cannot count.
  await db.upsert(
    'session',
    [
      {
        ...sessionRow,
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

/** One visit's detail read, ready to be written with the rest of its client's. */
export interface VisitDetail {
  readonly kVisit: string;
  readonly response: WlResponse<unknown>;
  /** New fetch count for this session (PRD 7.3). */
  readonly detailFetchCount: number;
}

export interface WriteClientSessionsInput {
  readonly kBusiness: string;
  /** The client whose list these came from - they are the attendee on each. */
  readonly uid: string;
  readonly runId: string;
  readonly fetchedAt: string;
  readonly details: readonly VisitDetail[];
  /** Keys already stubbed this pass. See writeClientSession. */
  readonly stubbed?: Set<string>;
}

export interface WriteClientSessionsResult {
  readonly written: number;
  readonly unparseable: number;
}

/**
 * Writes EVERY visit of one client in a handful of round trips.
 *
 * WHY THIS EXISTS. `writeClientSession` costs seven SEQUENTIAL Supabase round
 * trips per visit - raw_wl, location, service, session, raw_link, session_staff,
 * attendance. Measured on the 1980 backfill at roughly 460ms each, that is ~3.7s
 * of latency per visit, and the whole pass ran at 2.18 visits/sec: ~3.8 hours for
 * the studio's ~30,000 remaining historical visits. WellnessLiving was never the
 * bottleneck; waiting on the database one row at a time was.
 *
 * A client with 82 visits used to cost 574 round trips. It now costs about seven,
 * because the work is the same shape for every visit and Postgres is perfectly
 * happy to take them all at once.
 *
 * ORDER IS STILL THE FK ORDER - stubs, then sessions, then the rows that point at
 * them. Batching changes how many statements that takes, not what may exist first.
 *
 * RAW FIDELITY IS NOT TRADED AWAY. Every payload is still stored, one raw_wl row
 * each, and still linked to the rows it produced. The insert returns the new ids
 * in the order they were sent, which is what makes the link possible in bulk - and
 * if the count ever came back different this REFUSES rather than linking payloads
 * to the wrong records, because a silently mis-attributed payload is worse than a
 * failed pass.
 */
export async function writeClientSessions(
  db: SupabaseClient,
  input: WriteClientSessionsInput,
): Promise<WriteClientSessionsResult> {
  if (input.details.length === 0) return { written: 0, unparseable: 0 };

  const parsedAll = input.details.map((d) => ({
    detail: d,
    parsed: parseVisitElement(d.response.body, input.kBusiness),
  }));
  const usable = parsedAll.filter(
    (p): p is { detail: VisitDetail; parsed: ParsedVisit } => p.parsed !== null,
  );
  const unparseable = parsedAll.length - usable.length;

  // 1. Every payload, verbatim, in one insert. Unparseable ones are stored too:
  // the payload is the evidence for why it could not be read.
  const rawIds = await db.insert<{ id: string }>(
    'raw_wl',
    parsedAll.map((p) => ({
      k_business: input.kBusiness,
      source_endpoint: '/v1/schedule/page/element',
      target_kind: 'record',
      target_key: p.detail.kVisit,
      payload: p.detail.response.body,
      http_status: p.detail.response.httpStatus,
      wl_status: 'ok',
      trace_id: p.detail.response.traceId,
      k_log: p.detail.response.kLog,
      run_id: input.runId,
      latency_ms: p.detail.response.latencyMs,
    })),
  );
  if (rawIds.length !== parsedAll.length) {
    throw new Error(
      `raw_wl returned ${String(rawIds.length)} ids for ${String(parsedAll.length)} payloads - ` +
        `refusing to link payloads to records by guesswork`,
    );
  }
  const idFor = new Map(parsedAll.map((p, i) => [p.detail.kVisit, rawIds[i]?.id]));

  if (usable.length === 0) return { written: 0, unparseable };

  // 2. Stubs, deduped across the whole client and skipped if this pass already
  // wrote them.
  const seen = input.stubbed;
  const need = (table: string, key: string): boolean => {
    const marker = `${table}:${key}`;
    if (seen?.has(marker) === true) return false;
    seen?.add(marker);
    return true;
  };
  const locations = [
    ...new Set(
      usable.map((u) => u.parsed.session.k_location).filter((k): k is string => k !== null),
    ),
  ].filter((k) => need('location', k));
  const services = [
    ...new Set(
      usable.map((u) => u.parsed.session.k_service).filter((k): k is string => k !== null),
    ),
  ].filter((k) => need('service', k));

  if (locations.length > 0) {
    await db.upsert(
      'location',
      locations.map((k_location) => ({ k_location, k_business: input.kBusiness })),
      { onConflict: 'k_location' },
    );
  }
  if (services.length > 0) {
    await db.upsert(
      'service',
      services.map((k_service) => ({ k_service, k_business: input.kBusiness })),
      { onConflict: 'k_service' },
    );
  }

  // 3. Sessions. Deduped on the composite key: one client can hold two visits to
  // the same occurrence, and a batch that repeats a key fights itself.
  const sessions = new Map<string, Record<string, unknown>>();
  for (const u of usable) {
    // id_visit belongs to attendance, never to session - see writeClientSession.
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropping it is
       the point: destructuring is what keeps it out of the session row. */
    const { id_visit: _drop, ...row } = u.parsed.session;
    sessions.set(`${row.k_period}|${row.dt_start_utc}`, {
      ...row,
      detail_fetch_count: u.detail.detailFetchCount,
      detail_fetched_at: input.fetchedAt,
    });
  }
  await db.upsert('session', [...sessions.values()], { onConflict: 'k_period,dt_start_utc' });

  // 4. Who taught, and who attended.
  const staff = new Map<string, Record<string, unknown>>();
  const attendance = new Map<string, Record<string, unknown>>();
  const links: Array<{ rawWlId: string; key: string }> = [];
  for (const u of usable) {
    const s = u.parsed.session;
    const key = `${s.k_period}|${s.dt_start_utc}`;
    const rawWlId = idFor.get(u.detail.kVisit);
    if (rawWlId !== undefined) links.push({ rawWlId, key });
    for (const st of u.parsed.staff) {
      staff.set(`${key}|${st.k_staff}`, {
        k_period: s.k_period,
        dt_start_utc: s.dt_start_utc,
        k_staff: st.k_staff,
        uid: null,
      });
    }
    attendance.set(`${key}|${input.uid}`, {
      k_period: s.k_period,
      dt_start_utc: s.dt_start_utc,
      uid: input.uid,
      k_business: input.kBusiness,
      k_visit: u.detail.kVisit,
      ...visitOutcome(s.id_visit),
    });
  }

  if (staff.size > 0) {
    await db.upsert('session_staff', [...staff.values()], {
      onConflict: 'k_period,dt_start_utc,k_staff',
    });
  }
  await db.upsert('attendance', [...attendance.values()], {
    onConflict: 'k_period,dt_start_utc,uid',
  });
  if (links.length > 0) {
    await db.insert(
      'raw_link',
      links.map((l) => ({
        raw_wl_id: l.rawWlId,
        table_name: 'session',
        record_key: l.key,
        field_group: 'visit',
      })),
    );
  }

  return { written: sessions.size, unparseable };
}
