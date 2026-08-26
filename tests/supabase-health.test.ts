import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { checkAll } from '../src/health/index.js';
import { checkSupabaseReachable } from '../src/supabase/health.js';
import { FakeProvider } from './helpers/fixtures.js';

const loadFake = () => loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: new FakeProvider() });

function response(status: number): Response {
  return new Response(status === 204 ? null : '{}', { status });
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

describe('checkSupabaseReachable', () => {
  it('reports ok and sends the service role key both ways round', async () => {
    const { supabase } = await loadFake();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200));

    const result = await checkSupabaseReachable(supabase, { fetch: fetchMock, now: makeClock() });

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${supabase.url}/rest/v1/`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.apikey).toBe(supabase.serviceRoleKey);
    expect(headers.Authorization).toBe(`Bearer ${supabase.serviceRoleKey}`);
  });

  it('distinguishes a rejected key from an unreachable project', async () => {
    const { supabase } = await loadFake();

    const rejected = await checkSupabaseReachable(supabase, {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(401)),
      now: makeClock(),
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.httpStatus).toBe(401);
    expect(rejected.detail).toMatch(/rejected/);

    const unreachable = await checkSupabaseReachable(supabase, {
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed')),
      now: makeClock(),
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.httpStatus).toBeUndefined();
    expect(unreachable.detail).toMatch(/not reachable/);
  });

  it('reports an unexpected status without claiming auth failure', async () => {
    const { supabase } = await loadFake();
    const result = await checkSupabaseReachable(supabase, {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(503)),
      now: makeClock(),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('503');
  });

  it('labels a timeout as such', async () => {
    const { supabase } = await loadFake();
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const result = await checkSupabaseReachable(supabase, {
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(timeout),
      timeoutMs: 1234,
      now: makeClock(),
    });
    expect(result.detail).toContain('timed out after 1234ms');
  });

  it('never leaks the key or the project host into the detail text', async () => {
    const { supabase } = await loadFake();
    const result = await checkSupabaseReachable(supabase, {
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new TypeError(`getaddrinfo ENOTFOUND ${supabase.url}`)),
      now: makeClock(),
    });
    expect(result.detail).not.toContain(supabase.url);
    expect(result.detail).not.toContain(supabase.serviceRoleKey);
  });
});

describe('checkAll', () => {
  /** Routes each probe to its own canned response: they call different hosts. */
  function routedFetch() {
    return vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      const url = calledUrl(input);
      if (url.includes('/oauth2/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'probe-token', expires_in: 3600 }), {
            status: 200,
          }),
        );
      }
      // The GHL probe searches for a deliberately unrouteable address, so an
      // empty contact list is the SUCCESSFUL answer, not a miss.
      if (url.includes('/contacts/search')) {
        return Promise.resolve(
          new Response(JSON.stringify({ contacts: [], total: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(response(200));
    });
  }

  // Three probes, and the ORDER is asserted: a health screen that silently
  // reordered would make two runs incomparable at a glance.
  it('probes Supabase, the WellnessLiving token endpoint, and GoHighLevel', async () => {
    const config = await loadFake();
    const results = await checkAll(config, { fetch: routedFetch(), now: makeClock() });

    expect(results.map((r) => r.target)).toEqual([
      'supabase:rest',
      'wl:oauth2',
      'ghl:contacts-search',
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('reports the WL probe as failed without failing the Supabase one', async () => {
    const config = await loadFake();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) {
        return Promise.resolve(new Response('{"error":"invalid_client"}', { status: 401 }));
      }
      return Promise.resolve(response(200));
    });

    const results = await checkAll(config, { fetch: fetchMock, now: makeClock() });

    const wl = results.find((r) => r.target === 'wl:oauth2');
    expect(results.find((r) => r.target === 'supabase:rest')?.ok).toBe(true);
    expect(wl?.ok).toBe(false);
    expect(wl?.httpStatus).toBe(401);
    // The operator needs to know WHICH credential, in WHICH environment.
    expect(wl?.detail).toContain('WL_CLIENT_ID');
    expect(wl?.detail).toContain('env "dev"');
  });

  it('never leaks the client secret into a probe result', async () => {
    const config = await loadFake();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 400 }));

    const results = await checkAll(config, { fetch: fetchMock, now: makeClock() });

    for (const result of results) {
      expect(result.detail).not.toContain(config.wl.clientSecret);
      expect(result.detail).not.toContain(config.wl.clientId);
    }
  });
});

/** Monotonic fake clock: keeps latency assertions deterministic. */
function makeClock(): () => number {
  let t = 0;
  return () => (t += 5);
}
