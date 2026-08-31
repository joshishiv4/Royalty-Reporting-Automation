import { describe, expect, it } from 'vitest';
import { wlDate } from '../src/sync/writer.js';
import { parseAttendanceList } from '../src/sync/attendance.js';
import { parseVisitElement } from '../src/sync/client-sessions.js';

/**
 * WellnessLiving sends MySQL's ZERO DATE for a date that is not set, and Postgres
 * refuses it outright:
 *
 *   SupabaseError: 22008: date/time field value out of range: "0000-00-00 00:00:00"
 *
 * Their own spec says so in as many words - `dt_confirm` "will be zero date +
 * time in case appointment is not yet confirmed by client" - so this is
 * documented behaviour, not an anomaly. It went unguarded in all six writers
 * because the endpoints read until then happened never to send one. The first
 * appointment attendance records did, and attendance_sync died on every batch
 * while reporting the bare word "SupabaseError".
 */

describe('wlDate', () => {
  it('reads the zero date as absent', () => {
    expect(wlDate('0000-00-00 00:00:00')).toBeNull();
  });

  it('reads a bare zero date as absent too', () => {
    expect(wlDate('0000-00-00')).toBeNull();
  });

  it('does NOT substitute the epoch', () => {
    // "never checked in" is the absence of a check-in. 1970-01-01 is a claim
    // about January 1970, and it would read as a real event forever after.
    expect(wlDate('0000-00-00 00:00:00')).not.toBe('1970-01-01T00:00:00.000Z');
  });

  it('treats empty and whitespace as absent, like WL means them', () => {
    expect(wlDate('')).toBeNull();
    expect(wlDate('   ')).toBeNull();
    expect(wlDate(null)).toBeNull();
    expect(wlDate(undefined)).toBeNull();
  });

  it('passes a real date through, trimmed', () => {
    expect(wlDate(' 2026-08-19 15:00:00 ')).toBe('2026-08-19 15:00:00');
  });

  it('does not mistake a real date that merely starts with a zero', () => {
    expect(wlDate('0001-01-01 00:00:00')).toBe('0001-01-01 00:00:00');
  });
});

describe('the writers that were dying on it', () => {
  it('attendance: a zero dt_register becomes no check-in, not an error', () => {
    const body = {
      a_list_active: [
        {
          uid: '1',
          k_visit: 'v1',
          id_visit: 3,
          dt_register: '0000-00-00 00:00:00',
          dt_book: '0000-00-00 00:00:00',
        },
      ],
    };
    const [row] = parseAttendanceList(body, 'kp', '2026-08-19 15:00:00', 'kb').rows;
    expect(row?.dt_checkin_utc).toBeNull();
    expect(row?.dt_booked_utc).toBeNull();
    // The outcome still lands: the date was missing, the verdict was not.
    expect(row?.is_attended).toBe(true);
  });

  it('client sessions: a zero start date makes the visit unstorable', () => {
    // dt_start_utc is NOT NULL and half the primary key, so a visit with no real
    // date must be skipped, never written keyed on nothing.
    const parsed = parseVisitElement(
      {
        k_appointment: 'a1',
        k_class_period: null,
        dt_date_global: '0000-00-00 00:00:00',
        dt_date_local: '0000-00-00 00:00:00',
      },
      'kb',
    );
    expect(parsed).toBeNull();
  });
});
