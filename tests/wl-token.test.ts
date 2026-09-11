import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { WlConfig } from '../src/config/schema.js';
import { WlAuthError, WlTokenClient } from '../src/wl/token.js';
import { FakeProvider } from './helpers/fixtures.js';

const HOUR_MS = 3_600_000;

async function wlConfig(): Promise<WlConfig> {
  const config = await loadConfig({
    processEnv: { APP_ENV: 'dev' },
    provider: new FakeProvider(),
  });
  return config.wl;
}

function tokenResponse(accessToken: string, expiresIn: number | null = 3600): Response {
  const body: Record<string, unknown> = { token_type: 'Bearer', access_token: accessToken };
  if (expiresIn !== null) body.expires_in = expiresIn;
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Controllable clock: tests advance time explicitly rather than waiting. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * The URL a mocked fetch was called with.
 *
 * fetch's first parameter is typed `RequestInfo | URL`, so a bare String()
 * risks "[object Object]". This client only ever passes a string.
 */
function calledUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return '';
}

describe('WlTokenClient - the request it makes', () => {
  it('posts client_credentials, form-encoded, to the AUTH host', async () => {
    const wl = await wlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse('tok-1'));

    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });
    await client.getAccessToken();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${wl.authBaseUrl}/oauth2/token`);
    // The whole point of WL_AUTH_HOST: the token must NOT go to the data host.
    expect(calledUrl(url)).not.toContain(wl.host);
    expect(init?.method).toBe('POST');

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const body = init?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe(wl.clientId);
    expect(body.get('client_secret')).toBe(wl.clientSecret);
  });

  it('sends no id_region or k_business - business scoping is meaningless pre-token', async () => {
    const wl = await wlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse('tok-1'));

    await new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now }).getAccessToken();

    const url = calledUrl(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain('id_region');
    expect(url).not.toContain('k_business');
  });
});

describe('WlTokenClient - caching and refresh', () => {
  it('reuses the cached token instead of fetching per call', async () => {
    const wl = await wlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse('tok-1'));
    const clock = fakeClock();
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: clock.now });

    const first = await client.getAccessToken();
    clock.advance(60_000);
    const second = await client.getAccessToken();

    expect(first).toBe('tok-1');
    expect(second).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes proactively at 55 minutes, before the 60-minute expiry', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(tokenResponse('tok-2'));
    const clock = fakeClock();
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: clock.now });

    await client.getAccessToken();

    // 54:59 - still inside the window, no refresh.
    clock.advance(54 * 60_000 + 59_000);
    expect(await client.getAccessToken()).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 55:00 - proactive refresh (PRD M01), five minutes before WL expires it.
    clock.advance(1_000);
    expect(await client.getAccessToken()).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('survives a run longer than one token life', async () => {
    const wl = await wlConfig();
    let issued = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      issued += 1;
      return Promise.resolve(tokenResponse(`tok-${String(issued)}`));
    });
    const clock = fakeClock();
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: clock.now });

    // Two hours of steady calling, one per minute.
    for (let minute = 0; minute < 120; minute += 1) {
      await client.getAccessToken();
      clock.advance(60_000);
    }

    // 55-minute refresh over 120 minutes: three tokens, not 120.
    expect(issued).toBe(3);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const wl = await wlConfig();
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    const all = Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    resolveFetch?.(tokenResponse('tok-1'));

    expect(await all).toEqual(['tok-1', 'tok-1', 'tok-1']);
    // A backfill's workers must not each fire their own token request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches again after a failed request rather than caching the failure', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(tokenResponse('tok-1'));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    await expect(client.getAccessToken()).rejects.toBeInstanceOf(WlAuthError);
    expect(await client.getAccessToken()).toBe('tok-1');
  });

  it('invalidate() forces a new token, for a 401 on a data call', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(tokenResponse('tok-2'));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    expect(await client.getAccessToken()).toBe('tok-1');
    client.invalidate();
    expect(await client.getAccessToken()).toBe('tok-2');
  });

  it('assumes WL’s documented hour when expires_in is absent', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(tokenResponse('tok-1', null));
    const clock = fakeClock();
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: clock.now });

    await client.getAccessToken();
    expect(client.status().expiresInMs).toBe(HOUR_MS);
  });

  it('does not refetch on every call when the token is shorter-lived than the skew', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(tokenResponse('tok-1', 60));
    const clock = fakeClock();
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: clock.now });

    await client.getAccessToken();
    clock.advance(10_000);
    await client.getAccessToken();

    // Skew is capped at half the life, so a 60s token is still fresh at 10s.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('WlTokenClient - failure classification', () => {
  const cases: ReadonlyArray<{ status: number; kind: string; retryable: boolean }> = [
    { status: 400, kind: 'auth', retryable: false },
    { status: 401, kind: 'auth', retryable: false },
    { status: 403, kind: 'auth', retryable: false },
    { status: 404, kind: 'permanent', retryable: false },
    { status: 429, kind: 'transient', retryable: true },
    { status: 500, kind: 'transient', retryable: true },
    { status: 503, kind: 'transient', retryable: true },
  ];

  for (const { status, kind, retryable } of cases) {
    it(`classifies HTTP ${String(status)} as ${kind}`, async () => {
      const wl = await wlConfig();
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('{"error":"nope"}', { status }));
      const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

      const error = await client.getAccessToken().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WlAuthError);
      expect((error as WlAuthError).kind).toBe(kind);
      expect((error as WlAuthError).isRetryable).toBe(retryable);
      expect((error as WlAuthError).httpStatus).toBe(status);
    });
  }

  it('treats a network failure as transient', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(Object.assign(new Error('boom'), { name: 'TypeError' }));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    const error = (await client.getAccessToken().catch((e: unknown) => e)) as WlAuthError;
    expect(error.kind).toBe('transient');
  });

  it('treats a timeout as transient and says so', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const client = new WlTokenClient(wl, {
      fetch: fetchMock,
      now: fakeClock().now,
      timeoutMs: 10_000,
    });

    const error = (await client.getAccessToken().catch((e: unknown) => e)) as WlAuthError;
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('timed out');
  });

  it('treats HTTP 200 with no access_token as permanent', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"token_type":"Bearer"}', { status: 200 }));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    const error = (await client.getAccessToken().catch((e: unknown) => e)) as WlAuthError;
    expect(error.kind).toBe('permanent');
  });

  it('points at WL_AUTH_HOST when the token endpoint 404s', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('not found', { status: 404 }));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    const error = (await client.getAccessToken().catch((e: unknown) => e)) as WlAuthError;
    expect(error.message).toContain('WL_AUTH_HOST');
  });

  it('names the environment, so "credentials rejected" is actionable', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 401 }));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now, env: 'prod' });

    const error = (await client.getAccessToken().catch((e: unknown) => e)) as WlAuthError;
    expect(error.message).toContain('env "prod"');
    expect(error.message).toContain('WL_CLIENT_ID');
  });

  it('names the environment on a transient failure too', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now, env: 'dev' });

    const error = (await client.getAccessToken().catch((e: unknown) => e)) as WlAuthError;
    expect(error.message).toContain('env "dev"');
  });

  it('omits the environment when the caller did not supply one', async () => {
    const wl = await wlConfig();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{}', { status: 401 }));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    const error = (await client.getAccessToken().catch((e: unknown) => e)) as WlAuthError;
    expect(error.message).not.toContain('env "');
  });

  it('never echoes the credentials in an error message', async () => {
    const wl = await wlConfig();
    // An error body that quotes back what it was sent - exactly the leak risk.
    const body = JSON.stringify({ error: 'invalid_client', sent: wl.clientSecret });
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(body, { status: 401 }));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    const error = (await client.getAccessToken().catch((e: unknown) => e)) as WlAuthError;
    expect(error.message).not.toContain(wl.clientSecret);
    expect(error.message).not.toContain(wl.clientId);
  });
});

describe('WlTokenClient - status()', () => {
  it('reports no token before the first call, and never the token itself', async () => {
    const wl = await wlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse('tok-1'));
    const client = new WlTokenClient(wl, { fetch: fetchMock, now: fakeClock().now });

    expect(client.status()).toEqual({ cached: false, expiresInMs: null, fetchCount: 0 });

    await client.getAccessToken();
    const status = client.status();

    expect(status.cached).toBe(true);
    expect(status.expiresInMs).toBe(HOUR_MS);
    expect(status.fetchCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain('tok-1');
  });
});
