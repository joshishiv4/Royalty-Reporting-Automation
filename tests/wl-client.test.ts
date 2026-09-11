import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { WlConfig } from '../src/config/schema.js';
import { WlClient, WlRequestError } from '../src/wl/client.js';
import { WlAuthError, WlTokenClient } from '../src/wl/token.js';
import { FakeProvider } from './helpers/fixtures.js';

async function wlConfig(): Promise<WlConfig> {
  const config = await loadConfig({
    processEnv: { APP_ENV: 'dev' },
    provider: new FakeProvider(),
  });
  return config.wl;
}

/**
 * The URL a mocked fetch was called with.
 *
 * fetch's first parameter is typed `RequestInfo | URL`, so a bare String()
 * risks "[object Object]". These clients only ever pass a string.
 */
function calledUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return '';
}

/** WL's success envelope. */
function ok(payload: Record<string, unknown> = {}, kLog = '[31.55msb]'): Response {
  return new Response(JSON.stringify({ status: 'ok', k_log: kLog, ...payload }), { status: 200 });
}

/**
 * WL's error envelope - HTTP 200 with a failure inside, shaped as observed in
 * the architecture doc (section 2b).
 */
function errorEnvelope(sid: string, sField: string | null = null): Response {
  return new Response(
    JSON.stringify({
      a_error: [
        {
          sid,
          s_message: 'No ID is specified.',
          s_field: sField,
          a_message_source: { '[k_log]': '[12.3msb]' },
        },
      ],
      status: sid,
      message: 'No ID is specified.',
    }),
    { status: 200 },
  );
}

function tokenResponse(token = 'tok-1'): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
}

/** Serves the token endpoint, and routes data calls to the supplied responses. */
function routed(...dataResponses: Array<Response | (() => Response)>) {
  let dataCall = 0;
  return vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
    const next = dataResponses[dataCall] ?? dataResponses[dataResponses.length - 1];
    dataCall += 1;
    if (next === undefined) return Promise.resolve(ok());
    // A factory, when the call may be retried: a Response body reads once only.
    return Promise.resolve(typeof next === 'function' ? next() : next);
  });
}

/** Transient failures now back off before retrying; no test should wait it out. */
const noSleep = (): Promise<void> => Promise.resolve();

const clock = () => {
  let t = 0;
  return () => (t += 5);
};

describe('WlClient - the token comes first', () => {
  it('fetches a token before the data call, in that order', async () => {
    const wl = await wlConfig();
    const fetchMock = routed(ok({ a_row: [] }));
    const client = new WlClient(wl, { fetch: fetchMock, now: clock() });

    await client.request('/v1/business');

    const urls = fetchMock.mock.calls.map(([input]) => calledUrl(input));
    expect(urls[0]).toContain('/oauth2/token');
    expect(urls[1]).toContain('/v1/business');
  });

  it('reuses the cached token across many calls - one auth call, not N', async () => {
    const wl = await wlConfig();
    const fetchMock = routed(ok(), ok(), ok(), ok(), ok());
    const client = new WlClient(wl, { fetch: fetchMock, now: clock() });

    for (let i = 0; i < 5; i += 1) await client.request('/v1/business');

    const tokenCalls = fetchMock.mock.calls.filter(([i]) => calledUrl(i).includes('/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('shares one token cache between every client built on it', async () => {
    const wl = await wlConfig();
    const fetchMock = routed(ok(), ok());
    // The shape a worker pool uses: one token client, many request clients.
    const tokens = new WlTokenClient(wl, { fetch: fetchMock, now: clock() });
    const workerA = new WlClient(wl, { fetch: fetchMock, now: clock(), tokens });
    const workerB = new WlClient(wl, { fetch: fetchMock, now: clock(), tokens });

    await Promise.all([workerA.request('/v1/business'), workerB.request('/v1/staff/list')]);

    const tokenCalls = fetchMock.mock.calls.filter(([i]) => calledUrl(i).includes('/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('sends the bearer token and the business scoping', async () => {
    const wl = await wlConfig();
    const fetchMock = routed(ok());
    const client = new WlClient(wl, { fetch: fetchMock, now: clock() });

    await client.request('/v1/business');

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
    const query = new URL(calledUrl(url)).searchParams;
    expect(query.get('id_region')).toBe(String(wl.idRegion));
    expect(query.get('k_business')).toBe(wl.kBusiness);
  });

  it('ensureAuthenticated fails the run up front, naming the environment', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 401 }));
    const client = new WlClient(wl, { fetch: fetchMock, now: clock(), env: 'prod' });

    const error = (await client.ensureAuthenticated().catch((e: unknown) => e)) as WlAuthError;
    expect(error).toBeInstanceOf(WlAuthError);
    expect(error.message).toContain('env "prod"');
    // No data call was attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('WlClient - HTTP 200 that is actually an error', () => {
  it('rejects a 200 whose status is not "ok"', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, { fetch: routed(errorEnvelope('id-empty')), now: clock() });

    const error = (await client
      .request('/v1/profile/purchase/list/element')
      .catch((e: unknown) => e)) as WlRequestError;

    expect(error).toBeInstanceOf(WlRequestError);
    expect(error.details.httpStatus).toBe(200);
    expect(error.details.sid).toBe('id-empty');
  });

  it('treats a bad-parameter sid as permanent, so retries are not burned', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, { fetch: routed(errorEnvelope('id-empty')), now: clock() });

    const error = (await client.request('/v1/user').catch((e: unknown) => e)) as WlRequestError;
    expect(error.kind).toBe('permanent');
    expect(error.isRetryable).toBe(false);
  });

  it('captures s_field so a support ticket knows what WL rejected', async () => {
    const wl = await wlConfig();
    const fetchMock = routed(errorEnvelope('id-empty', 'k_purchase_item'));
    const client = new WlClient(wl, { fetch: fetchMock, now: clock() });

    const error = (await client.request('/v1/user').catch((e: unknown) => e)) as WlRequestError;
    expect(error.details.sField).toBe('k_purchase_item');
  });

  it('classifies an unrecognised sid as permanent rather than retrying blindly', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, {
      fetch: routed(errorEnvelope('report-not-api')),
      now: clock(),
    });

    const error = (await client
      .request('/v1/report/data')
      .catch((e: unknown) => e)) as WlRequestError;
    expect(error.kind).toBe('permanent');
  });

  it('classifies a throttling sid as transient', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, {
      fetch: routed(() => errorEnvelope('rate-limit')),
      now: clock(),
      sleep: noSleep,
    });

    const error = (await client.request('/v1/user').catch((e: unknown) => e)) as WlRequestError;
    expect(error.kind).toBe('transient');
    expect(error.isRetryable).toBe(true);
  });

  it('accepts a genuine ok envelope and hands back the body', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, { fetch: routed(ok({ a_row: [1, 2, 3] })), now: clock() });

    const result = await client.request<{ a_row: number[] }>('/v1/report/data');
    expect(result.body.a_row).toEqual([1, 2, 3]);
    expect(result.httpStatus).toBe(200);
  });
});

describe('WlClient - k_log capture', () => {
  it('captures k_log on a successful call', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, { fetch: routed(ok({}, '[31.55msb]')), now: clock() });

    const result = await client.request('/v1/business');
    expect(result.kLog).toBe('[31.55msb]');
  });

  it('digs k_log out of a_message_source on an error', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, { fetch: routed(errorEnvelope('id-empty')), now: clock() });

    const error = (await client.request('/v1/user').catch((e: unknown) => e)) as WlRequestError;
    expect(error.details.kLog).toBe('[12.3msb]');
  });

  it('reports null rather than inventing a k_log when WL sends none', async () => {
    const wl = await wlConfig();
    const fetchMock = routed(new Response('{"status":"ok"}', { status: 200 }));
    const client = new WlClient(wl, { fetch: fetchMock, now: clock() });

    const result = await client.request('/v1/business');
    expect(result.kLog).toBeNull();
  });
});

describe('WlClient - failure classification and retry', () => {
  it('refreshes the token and retries once on a 401', async () => {
    const wl = await wlConfig();
    let tokenCalls = 0;
    let dataCalls = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) {
        tokenCalls += 1;
        return Promise.resolve(tokenResponse(`tok-${String(tokenCalls)}`));
      }
      dataCalls += 1;
      // First data call rejects the token; the retry succeeds.
      return Promise.resolve(dataCalls === 1 ? new Response('{}', { status: 401 }) : ok());
    });
    const client = new WlClient(wl, { fetch: fetchMock, now: clock() });

    const result = await client.request('/v1/business');

    expect(result.httpStatus).toBe(200);
    expect(dataCalls).toBe(2);
    // The dead token was discarded, so a second token was fetched.
    expect(tokenCalls).toBe(2);
  });

  it('gives up after one retry rather than looping on a persistent 401', async () => {
    const wl = await wlConfig();
    let dataCalls = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
      dataCalls += 1;
      return Promise.resolve(new Response('{}', { status: 401 }));
    });
    const client = new WlClient(wl, { fetch: fetchMock, now: clock() });

    await expect(client.request('/v1/business')).rejects.toBeInstanceOf(WlRequestError);
    expect(dataCalls).toBe(2);
  });

  it('classifies 5xx and 429 as transient, 404 as permanent', async () => {
    const wl = await wlConfig();
    for (const [status, kind] of [
      [500, 'transient'],
      [503, 'transient'],
      [429, 'transient'],
      [404, 'permanent'],
      [400, 'permanent'],
    ] as const) {
      const client = new WlClient(wl, {
        fetch: routed(() => new Response('{}', { status })),
        now: clock(),
        sleep: noSleep,
      });
      const error = (await client
        .request('/v1/business')
        .catch((e: unknown) => e)) as WlRequestError;
      expect(error.kind, `HTTP ${String(status)}`).toBe(kind);
    }
  });

  it('treats a timeout as transient and says so', async () => {
    const wl = await wlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    });
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: clock(),
      timeoutMs: 10_000,
      sleep: noSleep,
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('timed out');
  });
});

describe('WlClient - never leaks', () => {
  it('keeps the host, token and credentials out of error messages', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, {
      fetch: routed(errorEnvelope('id-empty')),
      now: clock(),
      env: 'dev',
    });

    const error = (await client.request('/v1/user').catch((e: unknown) => e)) as WlRequestError;

    expect(error.message).not.toContain(wl.clientSecret);
    expect(error.message).not.toContain(wl.clientId);
    expect(error.message).not.toContain(wl.host);
    expect(error.message).not.toContain('tok-1');
    // The path IS included - it is not a secret and a dead-letter row needs it.
    expect(error.details.path).toBe('/v1/user');
  });
});

describe('WlClient - a body-read failure is transient, not "unknown"', () => {
  it('classifies a reset mid-body with a real trace id and latency, host-safe', async () => {
    const wl = await wlConfig();
    // A clean connect, then the body stream dies - the second failure point
    // that used to escape the taxonomy entirely.
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.reject(new Error(`socket hang up: ${wl.host}`)),
      } as unknown as Response);
    });
    const client = new WlClient(wl, { fetch: fetchMock, now: clock(), sleep: noSleep, env: 'dev' });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error).toBeInstanceOf(WlRequestError);
    expect(error.kind).toBe('transient');
    // Was 'unknown' and 0 before the fix.
    expect(error.details.traceId).not.toBe('unknown');
    expect(error.details.traceId).toContain('.');
    expect(error.details.latencyMs).toBeGreaterThan(0);
    // The cause carried the host; the surfaced message must not.
    expect(error.message).not.toContain(wl.host);
  });
});

describe('WlClient - a mid-pass token failure keeps its message', () => {
  it('surfaces the credential error, not "unknown reason", when a refetch is rejected', async () => {
    const wl = await wlConfig();
    let tokenCalls = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) {
        tokenCalls += 1;
        if (tokenCalls === 1) return Promise.resolve(tokenResponse());
        // The credentials rotated under the run: the refetch is rejected.
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
        );
      }
      // The data call rejects the now-stale token, forcing the refetch above.
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'not-authenticated' }), { status: 401 }),
      );
    });
    const client = new WlClient(wl, { fetch: fetchMock, now: clock(), sleep: noSleep, env: 'dev' });
    await client.ensureAuthenticated();

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error).toBeInstanceOf(WlRequestError);
    expect(error.kind).toBe('auth');
    expect(error.message).toContain('credentials rejected');
    expect(error.details.traceId).not.toBe('unknown');
    // An auth failure gives the queue nothing to retry.
    expect(error.details.requeueAfterMs).toBeNull();
  });

  it('retries a transient token failure and can still succeed', async () => {
    const wl = await wlConfig();
    let tokenCalls = 0;
    let dataCalls = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) {
        tokenCalls += 1;
        // First token ok; the mid-pass refetch blips (503) once, then recovers.
        if (tokenCalls === 2) return Promise.resolve(new Response('{}', { status: 503 }));
        return Promise.resolve(tokenResponse(`tok-${String(tokenCalls)}`));
      }
      dataCalls += 1;
      if (dataCalls === 1)
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'not-authenticated' }), { status: 401 }),
        );
      return Promise.resolve(ok());
    });
    const client = new WlClient(wl, { fetch: fetchMock, now: clock(), sleep: noSleep, env: 'dev' });
    await client.ensureAuthenticated();

    const result = await client.request('/v1/business');

    expect(result.httpStatus).toBe(200);
  });
});
