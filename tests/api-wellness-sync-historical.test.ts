import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/wellness-sync-historical.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';

/**
 * The door tests: auth and method routing. The behaviour past the door
 * (config load, override write, pass invocation) is covered by the pass tests
 * and by monthlyChunks; here we only prove the endpoint refuses what it
 * should and accepts what it should, without depending on a real .env.
 */

const TOKEN = 'sync-trigger-token-0000';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` },
    ...overrides,
  };
}

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
});

describe('/api/wellness-sync-historical - the door', () => {
  it('refuses when no trigger token is configured - unset means locked', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', '');
    vi.stubEnv('CRON_SECRET', '');
    const { res, sent } = makeResponse();

    await handler(request({ headers: { authorization: 'Bearer whatever' } }), res);

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

  it('rejects methods that are neither GET, HEAD, nor POST', async () => {
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
