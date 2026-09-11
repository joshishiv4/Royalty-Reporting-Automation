import { describe, expect, it, vi } from 'vitest';
import handler, { isAuthorized, type HealthRequest, type HealthResponse } from '../api/health.js';

const TOKEN = 'a-long-enough-health-token-0000';

describe('isAuthorized', () => {
  it('accepts the exact bearer token, case-insensitively on the scheme', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`  Bearer   ${TOKEN}  `, TOKEN)).toBe(true);
  });

  it('locks the endpoint when no token is configured', () => {
    // The important case: an unset HEALTHCHECK_TOKEN must never mean "open".
    expect(isAuthorized(`Bearer ${TOKEN}`, undefined)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}`, '')).toBe(false);
    expect(isAuthorized(undefined, undefined)).toBe(false);
  });

  it('rejects a missing, malformed, or wrong credential', () => {
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized('', TOKEN)).toBe(false);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false); // no Bearer scheme
    expect(isAuthorized('Basic dXNlcjpwYXNz', TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(isAuthorized('Bearer ', TOKEN)).toBe(false);
  });

  it('handles a repeated Authorization header', () => {
    expect(isAuthorized([`Bearer ${TOKEN}`, 'Bearer other'], TOKEN)).toBe(true);
    expect(isAuthorized(['Bearer wrong'], TOKEN)).toBe(false);
  });
});

/** Captures what the handler sent, the way Vercel's res object is used. */
function makeResponse() {
  const sent: { code?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res: HealthResponse = {
    status(code) {
      sent.code = code;
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

const request = (overrides: Partial<HealthRequest> = {}): HealthRequest => ({
  method: 'GET',
  headers: {},
  ...overrides,
});

describe('health handler', () => {
  it('returns 401 with no token configured, without touching config', async () => {
    vi.stubEnv('HEALTHCHECK_TOKEN', '');
    const { res, sent } = makeResponse();

    await handler(request({ headers: { authorization: `Bearer ${TOKEN}` } }), res);

    expect(sent.code).toBe(401);
    expect(sent.body).toEqual({ error: 'unauthorized' });
    vi.unstubAllEnvs();
  });

  it('gives an identical 401 for a wrong token and an unconfigured one', async () => {
    vi.stubEnv('HEALTHCHECK_TOKEN', TOKEN);
    const wrong = makeResponse();
    await handler(request({ headers: { authorization: 'Bearer nope' } }), wrong.res);

    vi.stubEnv('HEALTHCHECK_TOKEN', '');
    const unset = makeResponse();
    await handler(request({ headers: { authorization: 'Bearer nope' } }), unset.res);

    // No oracle telling an attacker whether the endpoint is configured at all.
    expect(wrong.sent.code).toBe(unset.sent.code);
    expect(wrong.sent.body).toEqual(unset.sent.body);
    vi.unstubAllEnvs();
  });

  it('rejects non-GET methods', async () => {
    vi.stubEnv('HEALTHCHECK_TOKEN', TOKEN);
    const { res, sent } = makeResponse();

    await handler(request({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }), res);

    expect(sent.code).toBe(405);
    vi.unstubAllEnvs();
  });

  it('always sets no-store so a health verdict is never cached', async () => {
    const { res, sent } = makeResponse();
    await handler(request(), res);
    expect(sent.headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 naming missing keys when authorized but unconfigured', async () => {
    vi.stubEnv('HEALTHCHECK_TOKEN', TOKEN);
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
    await handler(request({ headers: { authorization: `Bearer ${TOKEN}` } }), res);

    expect(sent.code).toBe(500);
    const body = sent.body as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toContain('Missing');
    // Fails closed and says which keys - but no values.
    expect(body.detail).toContain('SUPABASE_URL');
    vi.unstubAllEnvs();
  });
});
