import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeWebhookRoute, type WebhookRouteDeps } from '../api/jotform-webhook.js';
import type { AppConfig } from '../src/config/schema.js';
import type { WebhookResult } from '../src/sync/lesson-signoff-webhook.js';

/**
 * The door of the Jotform webhook (task 039): who may knock, what body it
 * understands, and that it answers at once and leaves the work to waitUntil.
 * What happens past the door is lesson-signoff-webhook.test.ts.
 */

const KEY = 'webhook-key-0123456789abcdef';
const API_KEY = 'jotform-api-key-0123456789';
const BASE = 'https://app.example.test/api/jotform-webhook';

const CONFIG = {
  wl: { kBusiness: '111111' },
  runtime: { logLevel: 'info' },
  supabase: {},
  smtp: { host: 'smtp.example.test' },
  signoff: {
    to: 'admin@example.test',
    startDate: '2026-11-24',
    classes: ['Music For Everyone'],
    formHost: 'form.example.test',
    formId: '42',
    apiHost: 'api.example.test',
    apiKey: API_KEY,
    drive: {
      oauthHost: 'oauth.example.test',
      apiHost: 'drive.example.test',
      clientId: 'client-id-0000',
      clientSecret: 'client-secret-0000',
      refreshToken: 'refresh-token-0000',
      inboxFolderId: 'inbox',
      rootFolderId: 'root',
    },
  },
} as unknown as AppConfig;

function route(over: Partial<WebhookRouteDeps> = {}) {
  const started: Array<Promise<unknown>> = [];
  const processed: string[] = [];
  const deps: WebhookRouteDeps = {
    waitUntil: (p) => {
      started.push(p);
    },
    loadConfig: () => Promise.resolve(CONFIG),
    process: (_config, id) => {
      processed.push(id);
      return Promise.resolve<WebhookResult>({ kind: 'checked', outcome: 'signed' });
    },
    ...over,
  };
  return { POST: makeWebhookRoute(deps), started, processed };
}

function multipart(fields: Record<string, string>, key: string | null = KEY): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const url = key === null ? BASE : `${BASE}?key=${encodeURIComponent(key)}`;
  return new Request(url, { method: 'POST', body: form });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/api/jotform-webhook - the door', () => {
  it('refuses a call with no key', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', KEY);
    const r = route();
    const res = await r.POST(multipart({ submissionID: '9001' }, null));
    expect(res.status).toBe(401);
    expect(r.processed).toEqual([]);
  });

  it('refuses the wrong key', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', KEY);
    const r = route();
    const res = await r.POST(multipart({ submissionID: '9001' }, 'wrong-key-0000000000000000'));
    expect(res.status).toBe(401);
    expect(r.processed).toEqual([]);
  });

  // An unset key must LOCK the route, never open it - same 401 as a wrong key.
  it('refuses everyone while JOTFORM_WEBHOOK_KEY is unset', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', '');
    const r = route();
    expect((await r.POST(multipart({ submissionID: '9001' }, ''))).status).toBe(401);
    expect((await r.POST(multipart({ submissionID: '9001' }, KEY))).status).toBe(401);
    expect(r.processed).toEqual([]);
  });

  // Jotform posts multipart/form-data; Vercel's (req, res) helpers would see nothing.
  it('reads submissionID from a multipart body, answers 200 and hands the work on', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', KEY);
    const r = route();
    const res = await r.POST(
      multipart({ submissionID: '6714154895519676579', formID: '42', rawRequest: '{}' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, submissionId: '6714154895519676579' });
    expect(r.processed).toEqual(['6714154895519676579']);
    expect(r.started).toHaveLength(1);
  });

  it('reads a urlencoded body too', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', KEY);
    const r = route();
    const res = await r.POST(
      new Request(`${BASE}?key=${KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'submissionID=9001&formID=42',
      }),
    );
    expect(res.status).toBe(200);
    expect(r.processed).toEqual(['9001']);
  });

  // The id reaches a URL path and a PostgREST filter: only digits get through.
  it('refuses a missing or non-numeric submissionID', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', KEY);
    const r = route();
    expect((await r.POST(multipart({ formID: '42' }))).status).toBe(400);
    expect((await r.POST(multipart({ submissionID: '9001&outcome=is.null' }))).status).toBe(400);
    expect((await r.POST(multipart({ submissionID: '../user' }))).status).toBe(400);
    expect(r.processed).toEqual([]);
  });

  it('settings missing: 503 naming the keys, nothing started', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', KEY);
    const bare = {
      ...CONFIG,
      signoff: { ...CONFIG.signoff, apiKey: null },
    } as unknown as AppConfig;
    const r = route({ loadConfig: () => Promise.resolve(bare) });
    const res = await r.POST(multipart({ submissionID: '9001' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ missing: ['JOTFORM_API_KEY'] });
    expect(r.started).toEqual([]);
  });

  // What the RUNBOOK tells an operator to look for after a test submission.
  it('logs the result of the work done after the answer', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', KEY);
    const logged: string[] = [];
    const r = route({ write: (line) => logged.push(line) });
    await r.POST(multipart({ submissionID: '9001' }));
    await Promise.all(r.started);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? '{}')).toMatchObject({
      level: 'info',
      msg: 'jotform_webhook',
      submissionId: '9001',
      result: { kind: 'checked', outcome: 'signed' },
    });
  });

  // The background failure goes to Vercel's log: no key, no API key, no host.
  it('a failure after the answer is logged scrubbed of the keys and hosts', async () => {
    vi.stubEnv('JOTFORM_WEBHOOK_KEY', KEY);
    const logged: string[] = [];
    const r = route({
      write: (line) => logged.push(line),
      process: () =>
        Promise.reject(
          new Error(
            `GET https://api.example.test/submission/9001?key=${KEY} with ${API_KEY} failed for key ${KEY}`,
          ),
        ),
    });
    const res = await r.POST(multipart({ submissionID: '9001' }));
    expect(res.status).toBe(200);
    await Promise.all(r.started);

    expect(logged).toHaveLength(1);
    const line = logged[0] ?? '';
    expect(line).toContain('jotform_webhook_failed');
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain('api.example.test');
  });
});
