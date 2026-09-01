import { describe, expect, it } from 'vitest';
import { monthlyChunks } from '../src/sync/pass.js';

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
