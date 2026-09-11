import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/alerts.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';

/**
 * The door tests for the alert sweep: who may open it, and with which verbs.
 *
 * The behaviour past the door - what the digest says, which conditions it
 * reports - belongs to the notify tests. What is tested HERE is the thing that
 * is specific to this endpoint and easy to regress: it sends mail, so the
 * read-only token must not be able to reach it. Every other route in this
 * service accepts HEALTHCHECK_TOKEN for reads; copying that list into this file
 * would hand a polling token the ability to mail somebody, and nothing else
 * would notice.
 */

const SYNC_TOKEN = 'sync-trigger-token-0000';
const CRON_TOKEN = 'cron-secret-0000';
const HEALTH_TOKEN = 'healthcheck-token-0000';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${SYNC_TOKEN}` },
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

describe('/api/alerts - the door', () => {
  it('refuses a request with no token at all', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', SYNC_TOKEN);
    const { res, sent } = makeResponse();
    await handler(request({ headers: {} }), res);
    expect(sent.status).toBe(401);
  });

  it('refuses the wrong token', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', SYNC_TOKEN);
    const { res, sent } = makeResponse();
    await handler(request({ headers: { authorization: 'Bearer nope-0000000000' } }), res);
    expect(sent.status).toBe(401);
  });

  it('refuses everyone when no token is configured, rather than opening up', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', '');
    vi.stubEnv('CRON_SECRET', '');
    const { res, sent } = makeResponse();
    await handler(request(), res);
    expect(sent.status).toBe(401);
  });

  /**
   * The one that matters. Sending mail is an action, and HEALTHCHECK_TOKEN is
   * the token handed out so somebody can poll a status page. It is accepted by
   * /api/health and /api/sync-status and must not be accepted here.
   */
  it('does NOT accept the read-only healthcheck token, because this sends mail', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', SYNC_TOKEN);
    vi.stubEnv('HEALTHCHECK_TOKEN', HEALTH_TOKEN);
    const { res, sent } = makeResponse();
    await handler(request({ headers: { authorization: `Bearer ${HEALTH_TOKEN}` } }), res);
    expect(sent.status).toBe(401);
  });

  it('accepts CRON_SECRET, which is what Vercel Cron sends', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', '');
    vi.stubEnv('CRON_SECRET', CRON_TOKEN);
    const { res, sent } = makeResponse();
    await handler(request({ headers: { authorization: `Bearer ${CRON_TOKEN}` } }), res);
    // Past the door. Without a usable .env the config load then fails, which is
    // a 500 - the point is that it is no longer a 401.
    expect(sent.status).not.toBe(401);
  });

  it('rejects verbs that are neither a cron GET nor a manual POST', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', SYNC_TOKEN);
    const { res, sent } = makeResponse();
    await handler(request({ method: 'DELETE' }), res);
    expect(sent.status).toBe(405);
  });

  it('never lets a response be cached', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', SYNC_TOKEN);
    const { res, sent } = makeResponse();
    await handler(request({ headers: {} }), res);
    expect(sent.headers['Cache-Control']).toBe('no-store');
  });
});
