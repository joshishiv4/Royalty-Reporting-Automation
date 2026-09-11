import { describe, expect, it } from 'vitest';
import { parseAttendanceList } from '../src/sync/attendance.js';
import { parseSessionList } from '../src/sync/sessions.js';
import { parseServiceList } from '../src/sync/services.js';
import {
  VISIT_ATTEND,
  VISIT_CANCEL,
  VISIT_PENALTY,
  VISIT_TRUANCY,
} from '../src/sync/visit-outcome.js';

/**
 * The traps found while verifying the WellnessLiving API (PRD M11).
 *
 * Every one of these is a failure that throws NOTHING. It produces a number
 * that looks entirely reasonable and is wrong, which in a royalty system is the
 * worst kind: nobody investigates a plausible figure. The other tests in this
 * repo check that things work; these check that a specific wrong answer cannot
 * come back.
 */

const K_BUSINESS = '111111';

// ===========================================================================
// TRAP: the obvious duration field is ZERO
// ===========================================================================

/**
 * Measured on a stored payload from /v1/appointment/book/service/list:
 *
 *   i_duration       0
 *   i_duration_real  45
 *   s_service        "Music Private | Virtual | 45 Minutes"
 *
 * The field called `i_duration` is zero on every service. `i_duration_real`
 * carries the length, and the title agrees with it. Reading the obvious name
 * gives every service a duration of zero - no error, no empty column, just a
 * catalogue in which nothing lasts any time at all.
 *
 * The board recorded this trap as "minutes on schedule endpoints, seconds on
 * staff endpoints". Measured against live data that is not what happens here:
 * session durations and service durations are BOTH minutes and both agree with
 * their titles (90 -> 90, 45 -> 45). No endpoint in use returns seconds. The
 * real trap on this endpoint is the zero, so that is what is pinned.
 */
describe('duration comes from the field that actually carries it', () => {
  const serviceBody = {
    a_service: {
      s1: {
        k_service: 's1',
        s_service: 'Music Private | Virtual | 45 Minutes',
        // The zero that would silently become the stored duration.
        i_duration: 0,
        i_duration_real: 45,
      },
    },
  };

  it('reads i_duration_real, not the i_duration that WL leaves at zero', () => {
    expect(parseServiceList(serviceBody, K_BUSINESS)[0]?.i_duration).toBe(45);
  });

  // The whole point: a 45-minute service must not be stored as lasting nothing.
  it('never stores a zero-length service when WL knows the length', () => {
    expect(parseServiceList(serviceBody, K_BUSINESS)[0]?.i_duration).not.toBe(0);
  });

  /**
   * Sessions are the other side of it. Here `i_duration` IS the value and it is
   * in minutes - confirmed live, where a class titled "90 Minutes" stores 90.
   * The two endpoints disagree about which field to trust, which is exactly why
   * each needs its own test rather than one shared helper nobody re-checks.
   */
  it('takes a session duration straight from i_duration, in minutes', () => {
    const parsed = parseSessionList(
      {
        a_session: {
          x: {
            k_class_period: 'p1',
            dt_date: '2026-08-19 15:00:00',
            dtl_date: '2026-08-19 11:00:00',
            i_duration: 90,
            text_title: 'DJ Group Class | 90 Minutes',
          },
        },
      },
      K_BUSINESS,
    );
    expect(parsed.sessions[0]?.i_duration_min).toBe(90);
  });

  // A title saying 90 and a stored duration of 5400 would both look plausible.
  // Pinning the number against the title is what makes a unit slip visible.
  it('stores a duration that agrees with the title, not a seconds-shaped one', () => {
    const parsed = parseSessionList(
      {
        a_session: {
          x: {
            k_class_period: 'p1',
            dt_date: '2026-08-19 15:00:00',
            dtl_date: '2026-08-19 11:00:00',
            i_duration: 90,
            text_title: 'DJ Group Class | 90 Minutes',
          },
        },
      },
      K_BUSINESS,
    );
    const stored = parsed.sessions[0]?.i_duration_min;
    expect(stored).toBe(90);
    expect(stored).not.toBe(90 * 60);
  });
});

// ===========================================================================
// TRAP: money is a string, and turning it into a float loses cents
// ===========================================================================

/**
 * WellnessLiving sends money as strings - "280.00", "1293.90". Every column
 * holding it is numeric(12,2), and nothing in this codebase ever adds money up:
 * the strings go in untouched and Postgres does the arithmetic in numeric.
 *
 * The test below is the reason that rule exists. It sums a realistic mixed
 * payment set both ways and shows the float path drifting off the true total,
 * while the string path is exact. The drift is fractions of a cent per row -
 * invisible on one purchase, and real money across 22,000 of them.
 */
describe('money survives as an exact decimal, never as a float', () => {
  /** A real-shaped mix: card, cash, account credit, a refund, a tip. */
  const PAYMENTS = [
    '19.99',
    '0.01',
    '1293.90',
    '349.00',
    '628.00',
    '0.10',
    '0.20',
    '429.00',
    '-80.07',
    '30.00',
  ];

  /** Exact cents: parse to integer cents, add, and never touch a float. */
  const sumCents = (amounts: readonly string[]): bigint =>
    amounts.reduce((total, a) => {
      const negative = a.startsWith('-');
      const [whole = '0', frac = ''] = (negative ? a.slice(1) : a).split('.');
      const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
      return negative ? total - cents : total + cents;
    }, 0n);

  const TRUE_TOTAL_CENTS = 267013n; // 2,670.13

  it('totals a mixed payment set to the exact cent', () => {
    expect(sumCents(PAYMENTS)).toBe(TRUE_TOTAL_CENTS);
  });

  /**
   * The proof that the rule is not superstition. Summed as floats, this exact
   * set does not land on the true total - and nothing throws, warns, or looks
   * wrong.
   */
  it('shows the float route drifting off that total, silently', () => {
    const asFloat = PAYMENTS.reduce((t, a) => t + Number.parseFloat(a), 0);
    const asExact = Number(TRUE_TOTAL_CENTS) / 100;

    expect(asFloat).not.toBe(asExact);
    // Small enough to pass any eyeball check, which is what makes it dangerous.
    expect(Math.abs(asFloat - asExact)).toBeLessThan(0.01);
  });

  // Two cents that cannot be represented in binary. If a reader ever "tidies
  // up" by parsing money on the way in, this is where it starts.
  it('keeps the classic 0.1 + 0.2 case exact', () => {
    expect(sumCents(['0.10', '0.20'])).toBe(30n);
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('handles a refund as a negative without losing a cent', () => {
    expect(sumCents(['100.00', '-80.07'])).toBe(1993n);
  });

  // WL writes "280" as often as "280.00". Both are 28,000 cents.
  it('reads a whole-pound amount and a two-decimal one identically', () => {
    expect(sumCents(['280'])).toBe(sumCents(['280.00']));
  });
});

// ===========================================================================
// TRAP: two different cancellations that must never merge
// ===========================================================================

/**
 * The studio cancelling a class and a client cancelling their place are
 * different facts with different consequences. A studio cancellation earns
 * nobody anything; a client cancellation inside the notice window is usually
 * still billable. Merge them and a teacher is either paid for a class that
 * never ran or not paid for one they turned up to.
 *
 * They arrive from different endpoints on different records - `is_cancel` on
 * the SESSION, the visit status on the BOOKING - which is exactly how they end
 * up conflated by someone reading one and assuming the other.
 */
describe('a studio cancellation and a client cancellation stay apart', () => {
  const session = (isCancel: boolean) =>
    parseSessionList(
      {
        a_session: {
          x: {
            k_class_period: 'p1',
            dt_date: '2026-08-19 15:00:00',
            dtl_date: '2026-08-19 11:00:00',
            is_cancel: isCancel,
            text_title: 'DJ Group Class',
          },
        },
      },
      K_BUSINESS,
    ).sessions[0];

  it('reads is_cancel on the session as the STUDIO cancelling', () => {
    expect(session(true)?.is_cancelled_studio).toBe(true);
  });

  it('leaves a normal session uncancelled', () => {
    expect(session(false)?.is_cancelled_studio).toBe(false);
  });

  /**
   * The half that matters most: a client cancelling their own booking must not
   * mark the SESSION cancelled. The class still ran for everybody else.
   */
  // VISIT_ATTEND 3, VISIT_PENALTY 4 (cancelled late), VISIT_TRUANCY 5,
  // VISIT_CANCEL 6 (cancelled in time) - see src/sync/visit-outcome.ts.
  const attendance = (idVisit: string) =>
    parseAttendanceList(
      { a_list_active: { v1: { uid: 'u1', id_visit: idVisit } } },
      'p1',
      '2026-08-19T15:00:00Z',
      K_BUSINESS,
    ).rows[0];

  it('records a client cancellation on the BOOKING, not on the session', () => {
    const row = attendance(VISIT_CANCEL);
    expect(row?.is_cancelled_client).toBe(true);
    // The session object has no client-cancellation flag to set at all, which
    // is the structural half of keeping these apart.
    expect(session(false)).not.toHaveProperty('is_cancelled_client');
  });

  it('does not turn a client cancellation into a no-show', () => {
    const row = attendance(VISIT_CANCEL);
    expect(row?.is_no_show).toBe(false);
  });

  // Truancy is WL's word for "booked, did not come and did not cancel". It is
  // not a cancellation by anybody, and it bills differently again.
  it('does not turn a no-show into a cancellation', () => {
    const row = attendance(VISIT_TRUANCY);
    expect(row?.is_no_show).toBe(true);
    expect(row?.is_cancelled_client).toBe(false);
  });

  it('keeps a LATE client cancellation both cancelled and late', () => {
    const row = attendance(VISIT_PENALTY);
    expect(row?.is_cancelled_client).toBe(true);
    expect(row?.is_late_cancel).toBe(true);
  });

  it('does not mark an ordinary attendance as cancelled by anyone', () => {
    const row = attendance(VISIT_ATTEND);
    expect(row?.is_attended).toBe(true);
    expect(row?.is_cancelled_client).toBe(false);
    expect(row?.is_late_cancel).toBe(false);
  });
});
