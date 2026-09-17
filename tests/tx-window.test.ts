import { describe, expect, it } from 'vitest';
import { decodeWindow, encodeWindow, transactionWindow } from '../src/sync/tx-window.js';

/**
 * The transaction reports are filtered by a date range, and that range is a
 * WellnessLiving CACHE KEY: change it and WL starts a new build, so a window
 * that moves between polling invocations means the poll never finds a finished
 * report. These pin the rule that decides the window and the encoding that
 * freezes it.
 */

const HISTORY = '1980-01-01';
const NOW = Date.parse('2026-09-17T09:30:00.000Z');

describe('transactionWindow', () => {
  it('reaches back to the configured floor while nothing has drained cleanly', () => {
    const w = transactionWindow({
      historyStart: HISTORY,
      lookbackDays: 3,
      lastCleanCompletionAt: null,
      now: NOW,
    });
    expect(w).toEqual({
      dlStart: '1980-01-01',
      dlEnd: '2026-09-17',
      isInitial: true,
      isOverride: false,
    });
  });

  it('narrows to the daily overlap once a pass has drained cleanly', () => {
    const w = transactionWindow({
      historyStart: HISTORY,
      lookbackDays: 3,
      lastCleanCompletionAt: '2026-09-16T04:00:00.000Z',
      now: NOW,
    });
    expect(w.dlStart).toBe('2026-09-14');
    expect(w.dlEnd).toBe('2026-09-17');
    expect(w.isInitial).toBe(false);
  });

  /**
   * The lookback is anchored on NOW, not on the watermark. A job paused for
   * weeks would otherwise silently widen its daily window into a second
   * backfill - and on these reports a wide window is not merely slower, it is a
   * different, uncached report that has to be built from scratch.
   */
  it('anchors the overlap on now even when the watermark is ancient', () => {
    const w = transactionWindow({
      historyStart: HISTORY,
      lookbackDays: 3,
      lastCleanCompletionAt: '2026-01-01T00:00:00.000Z',
      now: NOW,
    });
    expect(w.dlStart).toBe('2026-09-14');
  });

  it('honours a manual window exactly, even after a clean drain', () => {
    const w = transactionWindow({
      historyStart: HISTORY,
      lookbackDays: 3,
      lastCleanCompletionAt: '2026-09-16T04:00:00.000Z',
      startOverride: '2026-07-01T00:00:00.000Z',
      endOverride: '2026-08-31T23:59:59.000Z',
      now: NOW,
    });
    expect(w).toEqual({
      dlStart: '2026-07-01',
      dlEnd: '2026-08-31',
      isInitial: false,
      isOverride: true,
    });
  });

  it('treats an end with no start as "everything up to here"', () => {
    const w = transactionWindow({
      historyStart: HISTORY,
      lookbackDays: 3,
      lastCleanCompletionAt: '2026-09-16T04:00:00.000Z',
      endOverride: '2026-08-31T00:00:00.000Z',
      now: NOW,
    });
    expect(w.dlStart).toBe('1980-01-01');
    expect(w.dlEnd).toBe('2026-08-31');
  });

  /**
   * A bare date is what these reports take. A time component would make the
   * filter - and therefore the cached build - different from the one the next
   * invocation asks for.
   */
  it('emits bare dates, never a timestamp', () => {
    for (const w of [
      transactionWindow({
        historyStart: HISTORY,
        lookbackDays: 3,
        lastCleanCompletionAt: null,
        now: NOW,
      }),
      transactionWindow({
        historyStart: HISTORY,
        lookbackDays: 3,
        lastCleanCompletionAt: '2026-09-16T04:00:00.000Z',
        now: NOW,
      }),
    ]) {
      expect(w.dlStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(w.dlEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('freezing the window', () => {
  it('round-trips through the cursor', () => {
    const encoded = encodeWindow({ dlStart: '2026-07-01', dlEnd: '2026-08-31' });
    expect(encoded).toBe('2026-07-01|2026-08-31');
    expect(decodeWindow(encoded)).toEqual({ dlStart: '2026-07-01', dlEnd: '2026-08-31' });
  });

  /**
   * A cursor that cannot be trusted has to send the caller back to the rule.
   * The failure being avoided: WL accepts a nonsense filter, builds it, matches
   * nothing, and the pass stores zero transactions while reporting success.
   */
  it('refuses anything that is not two plain dates', () => {
    expect(decodeWindow(null)).toBeNull();
    expect(decodeWindow('')).toBeNull();
    expect(decodeWindow('2026-07-01')).toBeNull();
    expect(decodeWindow('2026-07-01|')).toBeNull();
    expect(decodeWindow('2026-07-01|2026-08-31|extra')).toBeNull();
    expect(decodeWindow('undefined|undefined')).toBeNull();
    expect(decodeWindow('2026-07-01 00:00:00|2026-08-31 00:00:00')).toBeNull();
    // An inverted range fetches nothing and reports success - the quietest way
    // to waste a run, and the same thing 0031 refuses at the database.
    expect(decodeWindow('2026-08-31|2026-07-01')).toBeNull();
  });
});
