import { describe, expect, it } from 'vitest';
import { runBatch } from '../src/wl/batch.js';

/**
 * The measured case this exists for: 20 staff enriched one at a time took 21
 * calls and 14.6s, and a Vercel function is capped at 60s. So the assertions
 * that matter are the concurrency, the budget, and never silently truncating.
 */

/** Lets a test decide exactly when each item finishes. */
function gate() {
  const release: Array<() => void> = [];
  return {
    wait: (): Promise<void> => new Promise<void>((resolve) => release.push(resolve)),
    releaseAll: () => {
      while (release.length > 0) release.shift()?.();
    },
    pending: () => release.length,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock that only moves when a test moves it. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('runBatch - concurrency', () => {
  it('runs up to `concurrency` items at once, not one at a time', async () => {
    const g = gate();
    let inFlight = 0;
    let peak = 0;

    const run = runBatch(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await g.wait();
        inFlight -= 1;
        return n * 2;
      },
      { concurrency: 3 },
    );

    await flush();
    expect(inFlight).toBe(3);

    for (let i = 0; i < 10; i += 1) {
      g.releaseAll();
      await flush();
    }
    const outcome = await run;

    expect(peak).toBe(3);
    expect(outcome.results).toHaveLength(8);
  });

  it('keeps every worker busy - a slow item does not idle the others', async () => {
    // Item 0 finishes last. With fixed chunks it would block the whole chunk;
    // a pull-based pool lets the rest stream past it.
    const finished: number[] = [];
    const slow = gate();

    const run = runBatch(
      [0, 1, 2, 3, 4, 5],
      async (n) => {
        if (n === 0) await slow.wait();
        finished.push(n);
        return n;
      },
      { concurrency: 2 },
    );

    await flush();
    // 1..5 all got through while 0 was still parked.
    expect(finished).toEqual([1, 2, 3, 4, 5]);

    slow.releaseAll();
    const outcome = await run;

    expect(finished).toEqual([1, 2, 3, 4, 5, 0]);
    // Completion order was 1..5 then 0, but results keep INPUT order.
    expect(outcome.results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles a single item and an empty list without hanging', async () => {
    expect((await runBatch([], (n: number) => Promise.resolve(n))).results).toEqual([]);
    expect((await runBatch([7], (n) => Promise.resolve(n))).results).toEqual([7]);
  });

  it('never handles the same index twice', async () => {
    const seen: number[] = [];
    await runBatch(
      Array.from({ length: 50 }, (_, i) => i),
      (_item, index) => {
        seen.push(index);
        return Promise.resolve(index);
      },
      { concurrency: 8 },
    );

    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
  });
});

describe('runBatch - the time budget', () => {
  it('stops STARTING items once the budget is spent', async () => {
    const time = fakeTime();
    const started: number[] = [];

    const outcome = await runBatch(
      [1, 2, 3, 4, 5, 6],
      (n) => {
        started.push(n);
        time.advance(30); // each item costs 30ms
        return Promise.resolve(n);
      },
      { concurrency: 1, budgetMs: 100, now: time.now },
    );

    // 0, 30, 60, 90 are all under 100; the fifth check sees 120 and stops.
    expect(started).toEqual([1, 2, 3, 4]);
    expect(outcome.attempted).toBe(4);
    expect(outcome.budgetExhausted).toBe(true);
  });

  it('returns what it never started, so the caller can resume with exactly those', async () => {
    const time = fakeTime();
    const outcome = await runBatch(
      ['a', 'b', 'c', 'd', 'e'],
      (s) => {
        time.advance(60);
        return Promise.resolve(s.toUpperCase());
      },
      { concurrency: 1, budgetMs: 100, now: time.now },
    );

    expect(outcome.results).toEqual(['A', 'B']);
    // Not truncated silently: the rest come back to be picked up next run.
    expect(outcome.remaining).toEqual(['c', 'd', 'e']);
  });

  it('never abandons an item already in flight', async () => {
    const time = fakeTime();
    let completed = 0;

    const outcome = await runBatch(
      [1, 2, 3],
      (n) => {
        // Blows the whole budget mid-flight.
        time.advance(10_000);
        completed += 1;
        return Promise.resolve(n);
      },
      { concurrency: 1, budgetMs: 100, now: time.now },
    );

    // The first item was started, so it was seen through to the end.
    expect(completed).toBe(1);
    expect(outcome.results).toEqual([1]);
    expect(outcome.remaining).toEqual([2, 3]);
  });

  it('reports no budget exhaustion when everything fitted', async () => {
    const time = fakeTime();
    const outcome = await runBatch([1, 2, 3], (n) => Promise.resolve(n), {
      budgetMs: 1000,
      now: time.now,
    });

    expect(outcome.budgetExhausted).toBe(false);
    expect(outcome.remaining).toEqual([]);
  });

  it('measures the budget from the caller startedAt, not from batch entry', async () => {
    const time = fakeTime();
    // The caller burned 120ms of its own 100ms budget before reaching the batch.
    time.advance(120);

    const outcome = await runBatch([1, 2, 3], (n) => Promise.resolve(n), {
      budgetMs: 100,
      now: time.now,
      startedAt: 0,
    });

    // Already over, so nothing is started. Without startedAt the batch would
    // reset the clock and happily run the lot.
    expect(outcome.attempted).toBe(0);
    expect(outcome.remaining).toEqual([1, 2, 3]);
    expect(outcome.budgetExhausted).toBe(true);
  });

  it('still starts work when some budget remains', async () => {
    const time = fakeTime();
    time.advance(90); // 10ms of a 100ms budget left - that is not zero

    const outcome = await runBatch([1, 2, 3], (n) => Promise.resolve(n), {
      budgetMs: 100,
      now: time.now,
      startedAt: 0,
    });

    expect(outcome.results).toEqual([1, 2, 3]);
    expect(outcome.budgetExhausted).toBe(false);
  });
});

describe('runBatch - failure isolation', () => {
  it('one bad item does not lose the good ones', async () => {
    const outcome = await runBatch([1, 2, 3, 4, 5], (n) =>
      n === 3 ? Promise.reject(new Error('item 3 is bad')) : Promise.resolve(n * 10),
    );

    expect(outcome.results).toEqual([10, 20, 40, 50]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.item).toBe(3);
    expect(outcome.failures[0]?.index).toBe(2);
    expect((outcome.failures[0]?.error as Error).message).toBe('item 3 is bad');
  });

  it('survives every item failing', async () => {
    const outcome = await runBatch([1, 2, 3], () => Promise.reject(new Error('all bad')));

    expect(outcome.results).toEqual([]);
    expect(outcome.failures).toHaveLength(3);
    expect(outcome.attempted).toBe(3);
    expect(outcome.remaining).toEqual([]);
  });

  it('keeps the index so a failure lines up with the caller data', async () => {
    const outcome = await runBatch(['a', 'b', 'c'], (s, i) =>
      i === 1 ? Promise.reject(new Error('nope')) : Promise.resolve(s),
    );

    expect(outcome.failures[0]).toMatchObject({ item: 'b', index: 1 });
  });

  it('counts attempted as results plus failures', async () => {
    const outcome = await runBatch([1, 2, 3, 4], (n) =>
      n % 2 === 0 ? Promise.reject(new Error('even')) : Promise.resolve(n),
    );

    expect(outcome.attempted).toBe(outcome.results.length + outcome.failures.length);
    expect(outcome.attempted).toBe(4);
  });
});
