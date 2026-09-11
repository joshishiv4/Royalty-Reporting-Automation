import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/wellness-sync.js';
import type * as ConfigModule from '../src/config/index.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';

// loadConfig is wrapped so one test can force a NON-config throw through the
// handler's catch. It delegates to the real implementation by default, so every
// other test still resolves config for real.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock('../src/config/index.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../src/config/index.js');
  loadConfigMock.mockImplementation(actual.loadConfig);
  return { ...actual, loadConfig: loadConfigMock };
});

// The sync pass itself is tested in sync-pass.test.ts; here it is mocked so the
// route's own job - mapping the verdict to a status - is what gets exercised,
// with no real WL or Supabase calls.
const { passMock } = vi.hoisted(() => ({ passMock: vi.fn() }));
vi.mock('../src/sync/pass.js', () => ({ runStaffSyncPass: passMock }));

const TOKEN = 'sync-trigger-token-0000';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` },
    ...overrides,
  };
}

/** Captures what the handler sent, the way the platform would. */
function makeResponse() {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res: HttpResponse = {
    status(code) {
      sent.status = code;
      return res;
    },
    json(body) {
      sent.body = body;
    },
    setHeader(name, value) {
      sent.headers[name] = value;
    },
  };
  return { res, sent };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('/api/wellness-sync - the door', () => {
  it('refuses when no trigger token is configured - unset means locked', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', '');
    vi.stubEnv('CRON_SECRET', '');
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({ error: 'unauthorized' });
  });

  it('refuses a wrong token with the same response as an unconfigured one', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    const { res, sent } = makeResponse();

    await handler(request({ headers: { authorization: 'Bearer nope' } }), res);

    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({ error: 'unauthorized' });
  });

  it('refuses a missing Authorization header', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    const { res, sent } = makeResponse();

    await handler(request({ headers: {} }), res);

    expect(sent.status).toBe(401);
  });

  it('accepts CRON_SECRET, which is what Vercel Cron sends', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', '');
    vi.stubEnv('CRON_SECRET', TOKEN);
    vi.stubEnv('APP_ENV', '');
    const { res, sent } = makeResponse();

    await handler(request(), res);

    // Past the door: it failed on config, not on authorization.
    expect(sent.status).not.toBe(401);
  });

  it('rejects methods a cron would never use', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    const { res, sent } = makeResponse();

    await handler(request({ method: 'DELETE' }), res);

    expect(sent.status).toBe(405);
  });

  it('always sets no-store so a sync verdict is never cached', async () => {
    const { res, sent } = makeResponse();
    await handler(request(), res);
    expect(sent.headers['Cache-Control']).toBe('no-store');
  });
});

describe('/api/wellness-sync - the verdict', () => {
  it('returns 500 naming missing keys when authorized but unconfigured', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    vi.stubEnv('APP_ENV', 'dev');
    for (const key of [
      'WL_API_HOST',
      'WL_AUTH_HOST',
      'WL_ID_REGION',
      'WL_K_BUSINESS',
      'WL_CLIENT_ID',
      'WL_CLIENT_SECRET',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'GHL_API_TOKEN',
      'GHL_LOCATION_ID',
    ]) {
      vi.stubEnv(key, '');
    }
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(500);
    const body = sent.body as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toContain('WL_CLIENT_ID');
  });

  /** Full valid env so loadConfig resolves and the handler reaches the pass. */
  function stubResolvableEnv(): void {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    vi.stubEnv('APP_ENV', 'dev');
    const env: Record<string, string> = {
      WL_API_HOST: 'wl.example.test',
      WL_AUTH_HOST: 'wl-auth.example.test',
      WL_ID_REGION: '1',
      WL_K_BUSINESS: '111111',
      WL_CLIENT_ID: 'client-id-0000',
      WL_CLIENT_SECRET: 'client-secret-0000',
      SUPABASE_URL: 'https://project.supabase.example.test',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-0000',
      GHL_API_HOST: 'ghl.example.test',
      GHL_API_VERSION: '2021-07-28',
      GHL_API_TOKEN: 'ghl-token-0000',
      GHL_LOCATION_ID: 'location-0000',
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  }

  it('returns 503 when the pass verdict is failed', async () => {
    stubResolvableEnv();
    passMock.mockResolvedValueOnce({ runId: 'r', state: 'failed', error: 'Error' });
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(503);
    expect((sent.body as { state: string }).state).toBe('failed');
  });

  it('returns 200 for a partial verdict - budget ran out, not a failure', async () => {
    stubResolvableEnv();
    passMock.mockResolvedValueOnce({ runId: 'r', state: 'partial', itemsRemaining: 3 });
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(200);
    expect((sent.body as { state: string }).state).toBe('partial');
  });

  it('returns 200 when the pass is ok', async () => {
    stubResolvableEnv();
    passMock.mockResolvedValueOnce({ runId: 'r', state: 'ok', done: 1 });
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(200);
  });

  it('reduces an unexpected failure to its class name, never a host', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    // An error whose message embeds a host, as an undici connect error would.
    // It is not a config error, so its message must not reach the response.
    const host = 'wl-secret-host.internal.test';
    loadConfigMock.mockRejectedValueOnce(
      Object.assign(new Error(`connect ECONNREFUSED ${host}`), { name: 'FetchError' }),
    );
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(500);
    const body = sent.body as { ok: boolean; error: string; detail: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('sync failed unexpectedly');
    expect(body.detail).toBe('FetchError');
    // The whole payload, not just detail: the host must appear nowhere.
    expect(JSON.stringify(sent.body)).not.toContain(host);
  });

  it('still returns a config error message verbatim, since it names keys not values', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    vi.stubEnv('APP_ENV', 'nonsense');
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(500);
    const body = sent.body as { error: string; detail: string };
    expect(body.error).toBe('configuration could not be resolved');
    expect(body.detail).toContain('APP_ENV');
  });
});
