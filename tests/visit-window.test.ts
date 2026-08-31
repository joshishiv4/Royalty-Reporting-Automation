import { describe, expect, it } from 'vitest';
import { visitWindow, wlDateTime } from '../src/sync/visit-window.js';

const NOW = Date.parse('2026-08-31T04:00:00.000Z');
const base = {
  historyStart: '1980-01-01',
  lookbackDays: 2,
  now: NOW,
};

describe('the first run reaches all the way back', () => {
  it('starts at the configured floor when nothing has drained cleanly', () => {
    const w = visitWindow({ ...base, lastCleanCompletionAt: null });
    expect(w.dtuStart).toBe('1980-01-01 00:00:00');
    expect(w.isInitial).toBe(true);
  });

  it('keeps looking like a backfill until a run actually completes', () => {
    // The watermark moves ONLY on a clean drain. A backfill stopped by its budget
    // leaves it null, and the next run must reach back again rather than assume
    // the missing years were already read.
    expect(visitWindow({ ...base, lastCleanCompletionAt: null }).isInitial).toBe(true);
  });

  it('honours a different floor without touching the code', () => {
    const w = visitWindow({ ...base, historyStart: '2015-06-30', lastCleanCompletionAt: null });
    expect(w.dtuStart).toBe('2015-06-30 00:00:00');
  });
});

describe('after a clean completion it only re-reads the overlap', () => {
  it('looks back exactly the configured number of days', () => {
    const w = visitWindow({ ...base, lastCleanCompletionAt: '2026-08-30T04:00:00.000Z' });
    expect(w.dtuStart).toBe('2026-08-29 04:00:00');
    expect(w.dtuEnd).toBe('2026-08-31 04:00:00');
    expect(w.isInitial).toBe(false);
  });

  it('anchors on now, NOT on the watermark', () => {
    // A job paused for three weeks has a three-week-old watermark. Anchoring the
    // window on it would silently turn every resumed run into another backfill.
    const stale = visitWindow({ ...base, lastCleanCompletionAt: '2026-08-01T00:00:00.000Z' });
    const fresh = visitWindow({ ...base, lastCleanCompletionAt: '2026-08-30T04:00:00.000Z' });
    expect(stale.dtuStart).toBe(fresh.dtuStart);
  });

  it('a one-day lookback is a choice, not the default', () => {
    // Two days is deliberate: an outcome settles after the session runs, and WL
    // may sit on PENDING, so a single day can miss the moment the answer lands.
    expect(base.lookbackDays).toBe(2);
    const w = visitWindow({
      ...base,
      lookbackDays: 1,
      lastCleanCompletionAt: '2026-08-30T04:00:00.000Z',
    });
    expect(w.dtuStart).toBe('2026-08-30 04:00:00');
  });
});

describe('the format WellnessLiving actually accepts', () => {
  it('sends a time component, because a bare date is rejected', () => {
    // `dt_date=2026-08-19` -> dt-date-invalid. The silent trap in WL-API-NOTES.
    expect(wlDateTime(NOW)).toBe('2026-08-31 04:00:00');
    expect(wlDateTime(NOW)).not.toMatch(/T|Z/);
  });

  it('normalises a bare configured date to midnight rather than passing it through', () => {
    expect(visitWindow({ ...base, lastCleanCompletionAt: null }).dtuStart).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('is UTC, like every other dt_ value in this schema', () => {
    expect(visitWindow({ ...base, lastCleanCompletionAt: null }).dtuEnd).toBe(
      '2026-08-31 04:00:00',
    );
  });
});
