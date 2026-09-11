import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { AppConfig, WlConfig } from '../src/config/schema.js';
import { WlClient, type WlRequestError } from '../src/wl/client.js';
import {
  RETRY_SCHEDULE_MS,
  retryDelayMs,
  throttleBackoffMs,
  THROTTLE_BACKOFF_MS,
} from '../src/wl/retry.js';
import { runWellnessSync } from '../src/wl/sync.js';
import { FakeProvider } from './helpers/fixtures.js';

/**
 * Retry behaviour. There is deliberately NO client-side rate limit: WL publishes
 * no limit, so this service does not invent one - it reacts to what WL actually
 * says instead. What is asserted here:
 *
 *   - a throttle backs off on a widening, jittered ladder and the item is
 *     handed back for requeue rather than dropped
 *   - a permanent error costs exactly one call, because a bad parameter will be
 *     just as bad in twenty-five minutes
 *   - a throttled run still finishes
 *
 * Time is injected everywhere. A test that actually waited out a 25 minute
 * backoff would not be a test.
 */

const loadFake = (): Promise<AppConfig> =>
  loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: new FakeProvider() });

async function wlConfig(): Promise<WlConfig> {
  return (await loadFake()).wl;
}

/**
 * A clock that only moves when something sleeps.
 *
 * This is what makes the spacing assertions meaningful: if the limiter did not
 * wait, time would not advance, and the next slot would still be in the past.
 */
function fakeTime() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
    elapsed: () => t,
  };
}

function calledUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return '';
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
}

function ok(): Response {
  return new Response(JSON.stringify({ status: 'ok', k_log: '[1.1msb]' }), { status: 200 });
}

/** WL's throttle: HTTP 200 with a transient sid in the envelope. */
function throttled(headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      status: 'rate-limit',
      a_error: [{ sid: 'rate-limit', s_message: 'Too many requests.' }],
    }),
    { status: 200, headers },
  );
}

/** A bad parameter. Never succeeds, however long you wait. */
function permanent(): Response {
  return new Response(
    JSON.stringify({
      status: 'id-empty',
      a_error: [{ sid: 'id-empty', s_message: 'No ID is specified.', s_field: 'k_purchase' }],
    }),
    { status: 200 },
  );
}

/** Serves tokens, then the given factories to successive data calls. */
function routed(...dataResponses: Array<() => Response>) {
  let dataCall = 0;
  const counts = { data: 0 };
  const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
    counts.data += 1;
    const next = dataResponses[dataCall] ?? dataResponses[dataResponses.length - 1];
    dataCall += 1;
    return Promise.resolve(next === undefined ? ok() : next());
  });
  return { fetchMock, counts };
}

describe('a throttle backs off, widens and requeues', () => {
  it('backs off on a widening ladder rather than a fixed delay', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock, counts } = routed(throttled);
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0, // pin the jitter so the ladder itself is visible
    });

    await client.request('/v1/business').catch(() => undefined);

    // 1s, 5s, 25s - increasing, then it stops trying in-process.
    expect(time.slept).toEqual([1_000, 5_000, 25_000]);
    expect(counts.data).toBe(4);
  });

  it('adds jitter on top of the base delay, never below it', () => {
    expect(throttleBackoffMs(0, () => 0)).toBe(1_000);
    expect(throttleBackoffMs(0, () => 1)).toBe(1_200);
    expect(throttleBackoffMs(0, () => 0.5)).toBe(1_100);
    // The documented delay is the floor, so a reader checking the schedule
    // against the ticket sees the number they expect.
    expect(throttleBackoffMs(2, () => 0)).toBe(25_000);
  });

  it('prefers WL Retry-After over our own ladder', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock } = routed(() => throttled({ 'retry-after': '3' }), ok);
    const client = new WlClient(wl, { fetch: fetchMock, now: time.now, sleep: time.sleep });

    const result = await client.request('/v1/business');

    expect(time.slept).toEqual([3_000]);
    expect(result.httpStatus).toBe(200);
  });

  it('ignores an absurd Retry-After rather than stalling the run', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock } = routed(() => throttled({ 'retry-after': '86400' }), ok);
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    await client.request('/v1/business');

    expect(time.slept).toEqual([1_000]);
  });

  it('hands the item back for requeue once the in-process ladder is spent', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock } = routed(throttled);
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.kind).toBe('transient');
    expect(error.isRetryable).toBe(true);
    // Not dropped: the queue layer is told when to try again.
    expect(error.details.requeueAfterMs).toBe(60_000);
    expect(error.details.attempts).toBe(4);
  });

  it('terminates when WL sends Retry-After on every call, bounded by the ladder', async () => {
    // The bug this guards: Retry-After short-circuits the ladder's null return,
    // so a server that keeps sending it loops forever. On a capped function that
    // is a silent timeout with no summary and no requeue record. Measured 51
    // calls before this fix; the ladder length is the only thing that ends it.
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock, counts } = routed(() =>
      // Bailout so the unbounded-loop regression fails as an assertion, not an
      // out-of-memory crash: without the ladder bound this keeps consuming the
      // persistent Retry-After forever. Past the cap it returns success, so the
      // mutated loop ends with an inflated call count instead of hanging.
      counts.data > 10 ? ok() : throttled({ 'retry-after': '3' }),
    );
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    // Same bound as the no-Retry-After case above: ladder length + 1.
    expect(counts.data).toBe(THROTTLE_BACKOFF_MS.length + 1);
    // WL's delay was honoured while attempts remained, not our ladder.
    expect(time.slept).toEqual([3_000, 3_000, 3_000]);
    // And it is handed back with WL's own delay, not our ladder rung.
    expect(error.details.requeueAfterMs).toBe(3_000);
  });

  it('requeues a long Retry-After with WL delay instead of sleeping it in-process', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    // 5 minutes: too long to sleep inside a 60s function, so hand it straight
    // back with that exact delay rather than burning our ladder at ~1s.
    const { fetchMock, counts } = routed(() => throttled({ 'retry-after': '300' }));
    const client = new WlClient(wl, { fetch: fetchMock, now: time.now, sleep: time.sleep });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(counts.data).toBe(1); // no in-process retry at all
    expect(time.slept).toEqual([]);
    expect(error.details.requeueAfterMs).toBe(300_000); // WL's delay, honoured
  });

  it('selects the requeue rung from the prior-attempt count', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock } = routed(throttled); // no Retry-After: our own ladder
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    // An item the queue has already requeued twice lands on rung 2 (25 min), not
    // rung 0 (1 min) - the widening the M03 worker relies on.
    const error = (await client
      .request('/v1/business', { priorAttempt: 2 })
      .catch((e: unknown) => e)) as WlRequestError;
    expect(error.details.requeueAfterMs).toBe(1_500_000);

    // And once the ladder is spent it dead-letters: nothing left to requeue.
    const dead = (await client
      .request('/v1/business', { priorAttempt: 3 })
      .catch((e: unknown) => e)) as WlRequestError;
    expect(dead.details.requeueAfterMs).toBeNull();
  });
});

describe('a deadline stops retries before the pass budget is blown', () => {
  it('requeues instead of sleeping past the deadline', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock, counts } = routed(throttled);
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0, // pin the jitter so the ladder is 1s, 5s, 25s exactly
    });

    // now advances only on sleep. First backoff is 1s (0 + 1000 < 1500, allowed);
    // that lands now at 1000, and the next backoff is 5s (1000 + 5000 = 6000,
    // past the 1500 deadline) - so the second retry must not be started.
    const error = (await client
      .request('/v1/business', { deadline: 1500 })
      .catch((e: unknown) => e)) as WlRequestError;

    expect(counts.data).toBe(2); // initial + one retry, not the full ladder
    expect(time.slept).toEqual([1_000]);
    // Not dropped: the queue is still told when to try again.
    expect(error.details.requeueAfterMs).toBe(60_000);
  });

  it('is unbounded when no deadline is given, so a plain call is unchanged', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock, counts } = routed(throttled);
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    await client.request('/v1/business').catch(() => undefined);

    // The full ladder ran: no deadline means no early stop.
    expect(counts.data).toBe(4);
    expect(time.slept).toEqual([1_000, 5_000, 25_000]);
  });
});

describe('a permanent error fails immediately', () => {
  it('makes exactly one call and never sleeps', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock, counts } = routed(permanent);
    const client = new WlClient(wl, { fetch: fetchMock, now: time.now, sleep: time.sleep });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.kind).toBe('permanent');
    expect(counts.data).toBe(1);
    expect(time.slept).toEqual([]);
    expect(error.details.attempts).toBe(1);
  });

  it('gives the queue nothing to retry, so it goes straight to dead-letter', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const client = new WlClient(wl, {
      fetch: routed(permanent).fetchMock,
      now: time.now,
      sleep: time.sleep,
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.details.requeueAfterMs).toBeNull();
    expect(error.isRetryable).toBe(false);
  });
});

describe('the requeue schedule is 1, 5 and 25 minutes', () => {
  it('matches the documented schedule', () => {
    expect(RETRY_SCHEDULE_MS).toEqual([60_000, 300_000, 1_500_000]);
    expect(retryDelayMs(0, () => 0)).toBe(60_000);
    expect(retryDelayMs(1, () => 0)).toBe(300_000);
    expect(retryDelayMs(2, () => 0)).toBe(1_500_000);
  });

  it('jitters each step so a throttled fleet does not wake in lockstep', () => {
    expect(retryDelayMs(0, () => 1)).toBe(72_000);
    expect(retryDelayMs(1, () => 1)).toBe(360_000);
  });

  it('runs out rather than retrying forever', () => {
    expect(retryDelayMs(3, () => 0)).toBeNull();
    expect(retryDelayMs(99, () => 0)).toBeNull();
  });
});

describe('a throttled run still finishes', () => {
  it('succeeds when WL throttles and then recovers', async () => {
    const config = await loadFake();
    const time = fakeTime();
    // Every step is throttled once, then answers normally.
    let call = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
      call += 1;
      return Promise.resolve(call % 2 === 1 ? throttled() : ok());
    });

    const summary = await runWellnessSync(config, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    expect(summary.ok).toBe(true);
    expect(summary.steps.every((s) => s.ok)).toBe(true);
    // It waited rather than failing.
    expect(time.slept).toContain(1_000);
  });
});
