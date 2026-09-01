import { describe, expect, it } from 'vitest';
import { monthlyChunks, monthlyLookbackWindow } from '../src/sync/pass.js';

/**
 * Month-boundary rules the historical class loop rests on:
 *
 *   - No gaps: the day after chunk N's dtEnd is chunk N+1's dtStart.
 *   - No duplicates: the whole range is covered by exactly one chunk per calendar month.
 *   - Partial edges: a range that starts mid-month starts THERE, not on the 1st;
 *     a range that ends mid-month ends THERE, not on the last day.
 *
 * If any of these break, the pass either double-reads work already stored, or
 * silently misses days at a month boundary - which is exactly the failure mode
 * the ticket calls out ("month boundaries produce no gaps and no duplicates").
 */

describe('monthlyChunks', () => {
  it('emits ONE chunk when the range fits inside a single month', () => {
    const chunks = monthlyChunks('2025-06-10', '2025-06-20');
    expect(chunks).toEqual([{ ymKey: '2025-06', dtStart: '2025-06-10', dtEnd: '2025-06-20' }]);
  });

  it('emits two edge chunks and every full month in between', () => {
    const chunks = monthlyChunks('2026-08-05', '2026-09-05');
    expect(chunks).toEqual([
      { ymKey: '2026-08', dtStart: '2026-08-05', dtEnd: '2026-08-31' },
      { ymKey: '2026-09', dtStart: '2026-09-01', dtEnd: '2026-09-05' },
    ]);
  });

  it('has no gaps at month boundaries: chunk N+1 starts the day after chunk N ends', () => {
    const chunks = monthlyChunks('2025-01-15', '2025-04-05');
    expect(chunks.map((c) => c.ymKey)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04']);
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const endMs = Date.parse(chunks[i]!.dtEnd);
      const nextStartMs = Date.parse(chunks[i + 1]!.dtStart);
      // Exactly 24 hours apart - the day AFTER the previous chunk's end.
      expect(nextStartMs - endMs).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('handles February in a leap year correctly (29 days, not 28)', () => {
    const chunks = monthlyChunks('2024-02-01', '2024-03-01');
    expect(chunks[0]).toEqual({ ymKey: '2024-02', dtStart: '2024-02-01', dtEnd: '2024-02-29' });
    expect(chunks[1]).toEqual({ ymKey: '2024-03', dtStart: '2024-03-01', dtEnd: '2024-03-01' });
  });

  it('handles a year boundary without dropping December or January', () => {
    const chunks = monthlyChunks('2025-12-25', '2026-01-10');
    expect(chunks.map((c) => c.ymKey)).toEqual(['2025-12', '2026-01']);
    expect(chunks[0]!.dtEnd).toBe('2025-12-31');
    expect(chunks[1]!.dtStart).toBe('2026-01-01');
  });

  it('emits nothing when the end is before the start', () => {
    expect(monthlyChunks('2025-06-10', '2025-06-01')).toEqual([]);
  });

  it('emits one chunk for a single-day range', () => {
    expect(monthlyChunks('2025-06-15', '2025-06-15')).toEqual([
      { ymKey: '2025-06', dtStart: '2025-06-15', dtEnd: '2025-06-15' },
    ]);
  });
});

/**
 * The window the monthly run derives for itself when nobody has asked for one.
 *
 * The guarantee being protected: firing on the 1st, every calendar month is
 * re-read exactly once, in full, shortly after it ends. That only holds because
 * the window counts WHOLE MONTHS from the first of the month. A day-count
 * window ("the last 60 days") would cut a month in half, re-read that half
 * twice, and never cover the other half - which is the bug this shape exists to
 * avoid, and the one a future simplification would reintroduce.
 */
describe('monthlyLookbackWindow', () => {
  const on = (iso: string): number => Date.parse(`${iso}T04:00:00.000Z`);

  it('covers last month in full when it fires on the 1st, at the default of 2', () => {
    // The cron's real shape: 1 October, two months.
    expect(monthlyLookbackWindow(on('2026-10-01'), 2)).toEqual({
      start: '2026-09-01',
      end: '2026-10-01',
    });
  });

  it('starts on the FIRST of the month, never a rolling day count', () => {
    // Fired mid-month, the start is still the 1st - not "two months ago today".
    expect(monthlyLookbackWindow(on('2026-10-20'), 2)).toEqual({
      start: '2026-09-01',
      end: '2026-10-20',
    });
  });

  it('crosses a year boundary without landing on month zero', () => {
    expect(monthlyLookbackWindow(on('2027-01-01'), 3)).toEqual({
      start: '2026-11-01',
      end: '2027-01-01',
    });
  });

  it('covers only the current month at 1', () => {
    expect(monthlyLookbackWindow(on('2026-10-01'), 1)).toEqual({
      start: '2026-10-01',
      end: '2026-10-01',
    });
  });

  it('is OFF at zero, so the cadence can be disabled without deleting the cron', () => {
    expect(monthlyLookbackWindow(on('2026-10-01'), 0)).toBeNull();
  });

  it('every month is covered exactly once across a year of monthly firings', () => {
    // Twelve consecutive first-of-month runs at the default of 2. Each run
    // re-reads the month that just ended; no month is skipped.
    const covered: string[] = [];
    for (let m = 1; m <= 12; m += 1) {
      const w = monthlyLookbackWindow(on(`2027-${String(m).padStart(2, '0')}-01`), 2);
      covered.push(monthlyChunks(w!.start, w!.end)[0]!.ymKey);
    }
    expect(covered).toEqual([
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
      '2027-05',
      '2027-06',
      '2027-07',
      '2027-08',
      '2027-09',
      '2027-10',
      '2027-11',
    ]);
  });
});
