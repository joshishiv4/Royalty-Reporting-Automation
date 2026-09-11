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

describe('a manual window wins, and says so', () => {
  const clean = '2026-08-30T04:00:00.000Z';

  it('overrides the daily overlap on a job that has drained cleanly', () => {
    // The whole point of setting one is to override what the rule would choose,
    // so it is checked BEFORE the watermark branch, not after.
    const w = visitWindow({
      ...base,
      lastCleanCompletionAt: clean,
      startOverride: '2023-03-01T00:00:00.000Z',
      endOverride: '2023-04-01T00:00:00.000Z',
    });
    expect(w.dtuStart).toBe('2023-03-01 00:00:00');
    expect(w.dtuEnd).toBe('2023-04-01 00:00:00');
    expect(w.isOverride).toBe(true);
  });

  it('overrides the backfill too', () => {
    const w = visitWindow({
      ...base,
      lastCleanCompletionAt: null,
      startOverride: '2023-03-01T00:00:00.000Z',
      endOverride: null,
    });
    expect(w.dtuStart).toBe('2023-03-01 00:00:00');
    expect(w.isInitial).toBe(false);
    expect(w.isOverride).toBe(true);
  });

  it('an end with no start still reaches the configured floor', () => {
    // "up to here" means everything up to here, not an empty range.
    const w = visitWindow({
      ...base,
      lastCleanCompletionAt: clean,
      endOverride: '2023-04-01T00:00:00.000Z',
    });
    expect(w.dtuStart).toBe('1980-01-01 00:00:00');
    expect(w.dtuEnd).toBe('2023-04-01 00:00:00');
  });

  it('a start with no end runs to now', () => {
    const w = visitWindow({
      ...base,
      lastCleanCompletionAt: clean,
      startOverride: '2023-03-01T00:00:00.000Z',
    });
    expect(w.dtuEnd).toBe('2026-08-31 04:00:00');
  });

  it('falls back to the rule when both are null', () => {
    const w = visitWindow({
      ...base,
      lastCleanCompletionAt: clean,
      startOverride: null,
      endOverride: null,
    });
    expect(w.isOverride).toBe(false);
    expect(w.dtuStart).toBe('2026-08-29 04:00:00');
  });

  it('reports which rule produced the window, so a surprise explains itself', () => {
    const asRule = visitWindow({ ...base, lastCleanCompletionAt: clean });
    const asBackfill = visitWindow({ ...base, lastCleanCompletionAt: null });
    const asManual = visitWindow({
      ...base,
      lastCleanCompletionAt: clean,
      startOverride: '2023-03-01T00:00:00.000Z',
    });
    expect([asRule.isInitial, asRule.isOverride]).toEqual([false, false]);
    expect([asBackfill.isInitial, asBackfill.isOverride]).toEqual([true, false]);
    expect([asManual.isInitial, asManual.isOverride]).toEqual([false, true]);
  });
});
