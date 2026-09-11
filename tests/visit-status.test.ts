import { describe, expect, it } from 'vitest';
import { visitOutcome } from '../src/sync/visit-outcome.js';

/**
 * The mapping royalty is paid from.
 *
 * WHY THIS FILE EXISTS. attendance.is_attended used to be written from
 * session.is_checkin, which the API documents as "ready to be checked in" - a
 * capability, not an outcome. Measured on live dev 27 Aug 2026: is_checkin was
 * true on 0 of 4,423 sessions and is_attended on 4 of 4,431, so the royalty
 * attendance signal was empty and nothing was countable.
 *
 * The outcome comes from id_visit (WlVisitSid), and the enum was unreachable
 * because the API docs link it as Wl/Visit/VisitSid.php - a file that does not
 * exist. It is Wl/Visit/WlVisitSid.php:
 *
 *   1 BOOK  2 WAIT  3 ATTEND  4 PENALTY  5 TRUANCY  6 CANCEL  7 PENDING  8 REMOVE
 */

describe('what WellnessLiving says happened', () => {
  it('counts ATTEND as attended, and nothing else', () => {
    expect(visitOutcome('3')).toEqual({
      id_visit: '3',
      is_attended: true,
      is_no_show: false,
      is_cancelled_client: false,
      is_late_cancel: false,
    });
  });

  // TRUANCY is "missed the session WITHOUT cancellation". It is not a
  // cancellation, and conflating the two would let a no-show read as one.
  it('reads TRUANCY as a no-show, not a cancellation', () => {
    const o = visitOutcome('5');
    expect(o.is_no_show).toBe(true);
    expect(o.is_attended).toBe(false);
    expect(o.is_cancelled_client).toBe(false);
  });

  it('reads CANCEL as a cancellation that was in time', () => {
    const o = visitOutcome('6');
    expect(o.is_cancelled_client).toBe(true);
    expect(o.is_late_cancel).toBe(false);
    expect(o.is_attended).toBe(false);
  });

  /**
   * PENALTY is BOTH. It is a cancellation, and it is late - and is_late_cancel
   * exists (0004) precisely because a late one is "usually still billable",
   * which is a different question from whether it happened. Setting only one of
   * the two would lose whichever question is asked second.
   */
  it('reads PENALTY as a cancellation AND a late one', () => {
    const o = visitOutcome('4');
    expect(o.is_cancelled_client).toBe(true);
    expect(o.is_late_cancel).toBe(true);
    expect(o.is_attended).toBe(false);
  });
});

describe('what it refuses to claim', () => {
  // The whole reason is_attended became nullable. `false` would assert the
  // client did not turn up; for these statuses nobody knows yet.
  it.each([
    ['1', 'BOOK - reserved, has not happened'],
    ['2', 'WAIT - on the wait list'],
    ['7', 'PENDING - WL is waiting for staff to decide'],
    ['8', 'REMOVE - hidden in WL'],
  ])('leaves is_attended null for %s (%s)', (code) => {
    expect(visitOutcome(code).is_attended).toBeNull();
  });

  it('leaves is_attended null when WL sent no status at all', () => {
    expect(visitOutcome(null).is_attended).toBeNull();
  });

  /**
   * A code WL adds later must not read as absence. If a new status defaulted to
   * is_attended=false, every visit carrying it would silently become "did not
   * turn up" and stop earning - the same shape of failure as reading is_checkin.
   */
  it('treats an unknown status as unknown, not as absence', () => {
    const o = visitOutcome('99');
    expect(o.is_attended).toBeNull();
    expect(o.is_no_show).toBe(false);
    expect(o.is_cancelled_client).toBe(false);
    // Still recorded verbatim, so the new code is visible rather than dropped.
    expect(o.id_visit).toBe('99');
  });

  // Only one of these can be true at once - attendance_outcome_exclusive (0004)
  // rejects the row otherwise, and a constraint violation mid-sync is a failed
  // pass rather than a bad row.
  it.each([['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'], [null]])(
    'never sets attended together with cancelled, for %s',
    (code) => {
      const o = visitOutcome(code);
      expect(o.is_attended === true && o.is_cancelled_client).toBe(false);
    },
  );
});
