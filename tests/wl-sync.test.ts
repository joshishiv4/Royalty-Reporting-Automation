import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { AppConfig } from '../src/config/schema.js';
import { runWellnessSync } from '../src/wl/sync.js';
import { FakeProvider } from './helpers/fixtures.js';

const loadFake = (): Promise<AppConfig> =>
  loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: new FakeProvider() });

function calledUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return '';
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
}

/** Serves the token endpoint, then a WL success envelope for every data call. */
function happyFetch(payload: Record<string, unknown> = { a_row: [1, 2] }) {
  return vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
    return Promise.resolve(
      new Response(JSON.stringify({ status: 'ok', k_log: '[9.9msb]', ...payload }), {
        status: 200,
      }),
    );
  });
}

/** Throttle backoff is exercised in tests/wl-retry.test.ts; here it must not wait. */
const noSleep = (): Promise<void> => Promise.resolve();

const clock = () => {
  let t = 0;
  return () => (t += 5);
};

describe('runWellnessSync', () => {
  it('authenticates before any data call', async () => {
    const config = await loadFake();
    const fetchMock = happyFetch();

    await runWellnessSync(config, { fetch: fetchMock, now: clock(), sleep: noSleep });

    expect(calledUrl(fetchMock.mock.calls[0]?.[0])).toContain('/oauth2/token');
  });

  it('runs every step on ONE token', async () => {
    const config = await loadFake();
    const fetchMock = happyFetch();

    const summary = await runWellnessSync(config, {
      fetch: fetchMock,
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.ok).toBe(true);
    expect(summary.steps).toHaveLength(3);
    expect(summary.tokenFetches).toBe(1);
    expect(summary.steps.every((s) => s.ok)).toBe(true);
  });

  it('captures k_log and row counts per step', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: happyFetch({ a_location: [1, 2, 3] }),
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.steps[0]?.kLog).toBe('[9.9msb]');
    expect(summary.steps[0]?.collections).toEqual({ a_location: 3 });
  });

  it('counts KEYED OBJECTS as rows - which is how WL returns list endpoints', async () => {
    const config = await loadFake();
    // The real shape: a_staff keyed by uid, not an array (verified live).
    const summary = await runWellnessSync(config, {
      fetch: happyFetch({ a_staff: { '66162909': {}, '66086649': {} } }),
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.steps[0]?.collections).toEqual({ a_staff: 2 });
  });

  it('stops the whole run when authentication fails, attempting no steps', async () => {
    const config = await loadFake();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 401 }));

    const summary = await runWellnessSync(config, {
      fetch: fetchMock,
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.ok).toBe(false);
    expect(summary.steps).toHaveLength(0);
    expect(summary.skipped).toEqual(['business', 'locations', 'staff']);
    // The cron log has to say WHICH environment's credentials were refused.
    expect(summary.authError).toContain('env "dev"');
    // Exactly one call: the token attempt. No data call followed it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records a failed step without abandoning the rest of the pass', async () => {
    const config = await loadFake();
    let dataCall = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
      dataCall += 1;
      if (dataCall === 1) {
        // WL's HTTP-200-with-an-error-inside.
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'id-empty', a_error: [{ sid: 'id-empty' }] }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    });

    const summary = await runWellnessSync(config, {
      fetch: fetchMock,
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.ok).toBe(false);
    expect(summary.steps).toHaveLength(3);
    expect(summary.steps[0]?.ok).toBe(false);
    expect(summary.steps[0]?.sid).toBe('id-empty');
    expect(summary.steps[0]?.kind).toBe('permanent');
    expect(summary.steps[1]?.ok).toBe(true);
    expect(summary.steps[2]?.ok).toBe(true);
  });

  it('reports what the time budget skipped rather than truncating silently', async () => {
    const config = await loadFake();
    // Each now() reading advances a minute, so the budget is spent immediately.
    let t = 0;
    const summary = await runWellnessSync(config, {
      fetch: happyFetch(),
      now: () => (t += 60_000),
      budgetMs: 1,
    });

    expect(summary.ok).toBe(false);
    expect(summary.skipped.length).toBeGreaterThan(0);
    // A skipped run must never look complete.
    expect(summary.steps.length + summary.skipped.length).toBe(3);
  });

  it('never puts a credential or host in the summary', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: happyFetch(),
      now: clock(),
      sleep: noSleep,
    });

    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain(config.wl.clientSecret);
    expect(serialised).not.toContain(config.wl.clientId);
    expect(serialised).not.toContain(config.wl.host);
    expect(serialised).not.toContain('tok-1');
  });
});
