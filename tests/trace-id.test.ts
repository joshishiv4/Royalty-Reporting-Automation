import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { AppConfig, WlConfig } from '../src/config/schema.js';
import { createLogger } from '../src/logging/logger.js';
import { credentialValues } from '../src/logging/redact.js';
import { WlClient, type WlRequestError } from '../src/wl/client.js';
import { runWellnessSync } from '../src/wl/sync.js';
import { createTraceIds, readKLog } from '../src/wl/trace.js';
import { FakeProvider } from './helpers/fixtures.js';

/**
 * Two ids, and the distinction is the point of this file.
 *
 * `traceId` is ours and is always present. `kLog` is WL's and usually is not -
 * measured against the UAT host on 19 Aug 2026, the endpoints this service syncs
 * return no trace id at all, `/v1/lead/info` returns a real one, and a genuine
 * error envelope returned the placeholder string "0".
 */

const loadFake = (): Promise<AppConfig> =>
  loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: new FakeProvider() });

async function wlConfig(): Promise<WlConfig> {
  return (await loadFake()).wl;
}

function calledUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return '';
}

const noSleep = (): Promise<void> => Promise.resolve();

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
}

/** A success envelope with no trace id - what the synced endpoints actually send. */
function okNoTrace(): Response {
  return new Response(JSON.stringify({ status: 'ok', a_staff: { 'uid-1': {} } }), { status: 200 });
}

/** A success envelope WITH one, as /v1/lead/info actually returns. */
function okWithTrace(kLog = '[31.77ldu]'): Response {
  return new Response(JSON.stringify({ status: 'ok', k_log: kLog }), { status: 200 });
}

function errorEnvelope(sid = 'id-empty', kLog: string | null = '[12.3msb]'): Response {
  return new Response(
    JSON.stringify({
      status: sid,
      a_error: [
        {
          sid,
          s_message: 'No ID is specified.',
          s_field: 'k_purchase',
          ...(kLog === null ? {} : { a_message_source: { '[k_log]': kLog } }),
        },
      ],
    }),
    { status: 200 },
  );
}

function routed(...dataResponses: Array<() => Response>) {
  let dataCall = 0;
  return vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
    const next = dataResponses[dataCall] ?? dataResponses[dataResponses.length - 1];
    dataCall += 1;
    return Promise.resolve(next === undefined ? okNoTrace() : next());
  });
}

const clock = () => {
  let t = 0;
  return () => (t += 5);
};

describe('our internal trace id', () => {
  it('numbers calls under one run prefix so a whole pass greps together', () => {
    const traces = createTraceIds({ runId: 'a3f9c1d2' });

    expect(traces.runId).toBe('a3f9c1d2');
    expect(traces.next()).toBe('a3f9c1d2.1');
    expect(traces.next()).toBe('a3f9c1d2.2');
    expect(traces.next()).toBe('a3f9c1d2.3');
  });

  it('generates a distinct run id per pass when none is supplied', () => {
    const a = createTraceIds().runId;
    const b = createTraceIds().runId;

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('never repeats an id', () => {
    const traces = createTraceIds({ runId: 'run' });
    const seen = new Set(Array.from({ length: 500 }, () => traces.next()));

    expect(seen.size).toBe(500);
  });

  it('is present on a SUCCESSFUL call', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, { fetch: routed(okNoTrace), now: clock(), runId: 'r1' });

    const result = await client.request('/v1/business');

    expect(result.traceId).toBe('r1.1');
    // WL sent nothing, and null is the honest answer.
    expect(result.kLog).toBeNull();
  });

  it('is present on a FAILED call', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, {
      fetch: routed(() => errorEnvelope()),
      now: clock(),
      sleep: noSleep,
      runId: 'r2',
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.details.traceId).toBe('r2.1');
  });

  it('stays the SAME across the retry ladder - retries are one operation', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, {
      fetch: routed(() => errorEnvelope('rate-limit')),
      now: clock(),
      sleep: noSleep,
      random: () => 0,
      runId: 'r3',
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.details.attempts).toBe(4);
    // Four HTTP calls, one logical operation, one id. `attempts` records the rest.
    expect(error.details.traceId).toBe('r3.1');
    expect(error.details.requeueAfterMs).toBe(60_000);
  });

  it('advances per logical call, not per attempt', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, { fetch: routed(okNoTrace), now: clock(), runId: 'r4' });

    const first = await client.request('/v1/business');
    const second = await client.request('/v1/location/list');

    expect([first.traceId, second.traceId]).toEqual(['r4.1', 'r4.2']);
  });

  it('is shared across workers when the trace source is shared', async () => {
    const wl = await wlConfig();
    const traces = createTraceIds({ runId: 'shared' });
    const a = new WlClient(wl, { fetch: routed(okNoTrace), now: clock(), traces });
    const b = new WlClient(wl, { fetch: routed(okNoTrace), now: clock(), traces });

    const first = await a.request('/v1/business');
    const second = await b.request('/v1/business');

    expect([first.traceId, second.traceId]).toEqual(['shared.1', 'shared.2']);
    expect(a.runId).toBe(b.runId);
  });
});

describe("WL's own trace id, when they send one", () => {
  it('is captured on the endpoints that do send it', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, {
      fetch: routed(() => okWithTrace('[31.77ldu]')),
      now: clock(),
    });

    const result = await client.request('/v1/lead/info');

    expect(result.kLog).toBe('[31.77ldu]');
  });

  it('is dug out of a_message_source on a failure', () => {
    expect(readKLog({ a_error: [{ a_message_source: { '[k_log]': '[2.2msb]' } }] })).toBe(
      '[2.2msb]',
    );
  });

  it('rejects the "0" placeholder a real error envelope returned', () => {
    // Verbatim shape from POST /v1/profile/purchase/list, HTTP 200.
    const live = {
      a_error: [
        { a_message_source: { '[text_method]': 'POST', '[k_log]': '0' }, sid: 'method-nx' },
      ],
      status: 'method-nx',
    };
    // "0" would send support hunting a log entry that does not exist.
    expect(readKLog(live)).toBeNull();
  });

  it('rejects the other empty-ish spellings but keeps genuine ids', () => {
    for (const v of ['0', '00', '-', 'null', 'none', 'nil', 'N/A', 'undefined', '   ']) {
      expect(readKLog({ k_log: v }), v).toBeNull();
    }
    expect(readKLog({ k_log: '[31.77ldu]' })).toBe('[31.77ldu]');
    expect(readKLog({ k_log: '0abc' })).toBe('0abc');
    expect(readKLog({ k_log: '  [31.77ldu]  ' })).toBe('[31.77ldu]');
  });

  it('is null for a live success envelope from a synced endpoint', () => {
    // Verbatim key set from GET /v1/profile/purchase/list, HTTP 200.
    expect(readKLog({ a_purchase: {}, status: 'ok', s_version: '485069' })).toBeNull();
  });
});

describe('duration is recorded on failures too', () => {
  it('reports real elapsed time when WL rejects a call', async () => {
    const wl = await wlConfig();
    const client = new WlClient(wl, {
      fetch: routed(() => errorEnvelope()),
      now: clock(),
      sleep: noSleep,
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.details.latencyMs).toBeGreaterThan(0);
  });

  it('reports elapsed time on a timeout, the slowest failure of all', async () => {
    const wl = await wlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    });
    const client = new WlClient(wl, { fetch: fetchMock, now: clock(), sleep: noSleep });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    // Reporting a 30s timeout as 0ms hides the one number identifying it.
    expect(error.details.latencyMs).toBeGreaterThan(0);
  });

  it('a failed sync step reports its duration rather than zero', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: routed(() => errorEnvelope()),
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.steps.length).toBeGreaterThan(0);
    for (const step of summary.steps) {
      expect(step.ok).toBe(false);
      expect(step.latencyMs).toBeGreaterThan(0);
    }
  });
});

describe('a sync pass is traceable end to end', () => {
  it('every step carries an id sharing the pass run prefix', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: routed(okNoTrace),
      now: clock(),
      sleep: noSleep,
      runId: 'pass1',
    });

    expect(summary.runId).toBe('pass1');
    expect(summary.steps.map((s) => s.traceId)).toEqual(['pass1.1', 'pass1.2', 'pass1.3']);
  });

  it('ids survive a pass where some steps fail', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: routed(() => errorEnvelope(), okNoTrace, okNoTrace),
      now: clock(),
      sleep: noSleep,
      runId: 'mixed',
    });

    for (const step of summary.steps) {
      expect(step.traceId).toMatch(/^mixed\.\d+$/);
    }
    expect(summary.steps[0]?.ok).toBe(false);
  });
});

describe('log lines carry endpoint, duration, outcome and trace id', () => {
  it('and never a credential or personal data', async () => {
    const config = await loadFake();
    // A payload shaped like real WL member data.
    const personal = {
      status: 'ok',
      a_staff: {
        'uid-1': { s_first_name: 'Priya', s_mail: 'priya@example.com', s_phone: '+15550001111' },
      },
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
      return Promise.resolve(new Response(JSON.stringify(personal), { status: 200 }));
    });

    const summary = await runWellnessSync(config, {
      fetch: fetchMock,
      now: clock(),
      sleep: noSleep,
      runId: 'logs',
    });

    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      secrets: credentialValues(config),
      write: (line) => lines.push(line),
    });
    for (const step of summary.steps) {
      logger.info('sync step ok', {
        step: step.name,
        endpoint: step.path,
        latencyMs: step.latencyMs,
        outcome: step.ok ? 'ok' : 'failed',
        traceId: step.traceId,
        kLog: step.kLog,
      });
    }

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry.endpoint).toMatch(/^\/v1\//);
      expect(typeof entry.latencyMs).toBe('number');
      expect(entry.outcome).toBe('ok');
      expect(entry.traceId).toMatch(/^logs\.\d+$/);
    }

    const blob = lines.join('\n');
    // Only counts leave a step, never values.
    expect(blob).not.toContain('Priya');
    expect(blob).not.toContain('priya@example.com');
    expect(blob).not.toContain('+15550001111');
    for (const secret of credentialValues(config)) {
      expect(blob).not.toContain(secret);
    }
    // The host is configuration and must not reach a log either.
    expect(blob).not.toContain(config.wl.host);
    // Nor the access token.
    expect(blob).not.toContain('tok-1');
  });
});
