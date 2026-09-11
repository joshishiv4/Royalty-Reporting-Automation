import { describe, expect, it } from 'vitest';
import {
  jittered,
  MAX_IN_PROCESS_RETRY_AFTER_MS,
  parseRetryAfter,
  throttleBackoffMs,
  THROTTLE_BACKOFF_MS,
} from '../src/ghl/retry.js';

describe('GHL retry ladder', () => {
  it('shape mirrors the WL ladder: 1s / 5s / 25s in-process', () => {
    expect(THROTTLE_BACKOFF_MS).toEqual([1_000, 5_000, 25_000]);
  });

  it('adds jitter on top, never subtracts', () => {
    // Random pinned to 0 -> base exactly, no shortening below the documented floor.
    expect(jittered(1_000, () => 0)).toBe(1_000);
    // Random pinned to 1 -> base + 20%.
    expect(jittered(1_000, () => 1)).toBe(1_200);
  });

  it('throttleBackoffMs returns null past the ladder length', () => {
    for (let i = 0; i < THROTTLE_BACKOFF_MS.length; i += 1) {
      expect(throttleBackoffMs(i, () => 0)).toBe(THROTTLE_BACKOFF_MS[i]);
    }
    expect(throttleBackoffMs(THROTTLE_BACKOFF_MS.length, () => 0)).toBeNull();
  });

  it('caps in-process Retry-After at the end of the ladder', () => {
    // Whatever the ceiling is, it must be at least as long as the ladder's last
    // rung - otherwise a compliant Retry-After would be refused when a made-up
    // wait of the same length would be honoured.
    expect(MAX_IN_PROCESS_RETRY_AFTER_MS).toBeGreaterThanOrEqual(25_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads a seconds value', () => {
    expect(parseRetryAfter('3', 0)).toBe(3_000);
  });

  it('reads an HTTP date value', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5_000);
  });

  it('rejects negatives', () => {
    expect(parseRetryAfter('-5', 0)).toBeNull();
  });

  it('rejects absurdly long values so a bad header cannot stall a run for a day', () => {
    expect(parseRetryAfter('86400', 0)).toBeNull();
  });

  it('accepts a missing header as "no instruction"', () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('   ', 0)).toBeNull();
  });
});
