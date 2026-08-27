/**
 * WellnessLiving's visit status, and the one place it is turned into outcomes.
 *
 * WHY THIS IS ITS OWN MODULE. Two passes learn what happened at a session, from
 * two different endpoints:
 *
 *   /v1/schedule/page/element   per client, per visit  -> client-sessions.ts
 *   /v1/login/attendance/list   per class occurrence   -> attendance.ts
 *
 * Both write the same `attendance` columns, and those columns decide what a
 * royalty is paid on. When the rule lived inside one of the two writers, the
 * other one grew its own version: `attendance.ts` derived `is_attended` from
 * `is_visit`/`is_attend` and never wrote `id_visit` at all, so the same visit
 * could be described two ways depending on which pass reached it first. Measured
 * on live dev 27 Aug 2026: `id_visit` was null on 4,431 of 4,431 attendance rows
 * and `session_outcome.is_countable` was true on 0 - while 4,990 stored
 * page/element payloads each carried the status, and 55 of 55 sampled
 * attendance-list client records carried it too.
 *
 * So the rule is here, once, and both writers import it. Migration 0029 encodes
 * the same mapping in SQL for rows already in the table; if you change one, change
 * both, and say so in the migration.
 *
 * ID_VISIT IS THE AUTHORITY, NOT THE BOOLEANS. WL sends `is_attend`, `is_visit`,
 * `is_truancy`, `is_penalty` and `is_pending` alongside it on the attendance
 * list, none of which appear in the published spec. They agree with `id_visit`
 * where both are present, and `id_visit` is the field WL documents as "the status
 * of the visit" - so the booleans are a fallback for a payload that omits the
 * status, never an override.
 */

/** WellnessLiving's `WlVisitSid` - the statuses a visit can hold. */
export const VISIT_ATTEND = '3';
export const VISIT_PENALTY = '4';
export const VISIT_TRUANCY = '5';
export const VISIT_CANCEL = '6';

/**
 * The outcome columns on `attendance`, derived from one status code.
 *
 * `is_attended` is deliberately nullable. `not null default false` claimed every
 * visit was un-attended until proven otherwise, in the column royalty is paid
 * from - see migration 0029. Null means "not known yet": the session has not
 * happened, or WL has it PENDING for staff to decide, or nothing has read the
 * detail. False means WL said they did not turn up.
 */
export interface VisitOutcome {
  id_visit: string | null;
  is_attended: boolean | null;
  is_no_show: boolean;
  is_cancelled_client: boolean;
  is_late_cancel: boolean;
}

/**
 * Maps a `WlVisitSid` code to what it says happened.
 *
 * An unrecognised code returns the unknown shape rather than "not attended" - WL
 * may add one, and a new code must not silently read as absence.
 *
 * Exported so the mapping is testable on a literal rather than only through a
 * fake database. It decides what a royalty is paid on; it should not be
 * reachable only by simulating a sync.
 */
export function visitOutcome(idVisit: string | null): VisitOutcome {
  const unknown: VisitOutcome = {
    id_visit: idVisit,
    is_attended: null,
    is_no_show: false,
    is_cancelled_client: false,
    is_late_cancel: false,
  };

  switch (idVisit) {
    case VISIT_ATTEND: // 3 ATTEND - client has attended the session
      return { ...unknown, is_attended: true };
    case VISIT_TRUANCY: // 5 TRUANCY - missed it, without cancelling
      return { ...unknown, is_attended: false, is_no_show: true };
    case VISIT_CANCEL: // 6 CANCEL - cancelled in time, no penalty
      return { ...unknown, is_attended: false, is_cancelled_client: true };
    case VISIT_PENALTY: // 4 PENALTY - cancelled too late. Still a cancellation, and late.
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
 * Reads a WL status code as text.
 *
 * WL sends `id_visit` as a JSON number; every other WL key in this schema is text
 * because a leading zero is lost as an integer, and because a code should not be
 * arithmetic. Zero is not a valid `WlVisitSid` value, so a falsy number is
 * treated as absent rather than as `"0"`.
 */
export function readVisitCode(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return String(value);
  if (typeof value === 'string' && value.length > 0 && value !== '0') return value;
  return null;
}
