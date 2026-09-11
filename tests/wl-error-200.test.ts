import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { AppConfig } from '../src/config/schema.js';
import { runWellnessSync } from '../src/wl/sync.js';
import { FakeProvider } from './helpers/fixtures.js';

/**
 * WellnessLiving answers HTTP 200 for errors. Trusting the status code writes
 * empty rows and reports success, so success is read from the body and nowhere
 * else - see the header of src/wl/client.ts.
 *
 * tests/wl-client.test.ts already proves the client REJECTS such a response.
 * This file proves the consequence that matters: the rejected body never
 * becomes data. Stated honestly, there is no database yet - src/wl/sync.ts is
 * read-only until the schema (M02) and worker layer (M03) land. So the assertion
 * is made at the boundary that will feed it: a failed step contributes no row
 * counts and no payload, and the pass reports not-ok. When a writer is added it
 * consumes step output, and these tests fail if a poisoned step carries any.
 */

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

/**
 * A WL error carried on HTTP 200, with a payload that LOOKS like rows.
 *
 * The decoy collections are the point: if anything ever counted or mapped the
 * body before checking `status`, these would surface as rows and fail the test.
 */
function errorWith200(sid = 'id-empty'): Response {
  return new Response(
    JSON.stringify({
      status: sid,
      message: 'No ID is specified.',
      a_error: [
        {
          sid,
          s_message: 'No ID is specified.',
          s_field: 'k_purchase_item',
          a_message_source: { '[k_log]': '[12.3msb]' },
        },
      ],
      a_staff: { 'uid-1': { s_name: 'decoy' }, 'uid-2': { s_name: 'decoy' } },
      a_location: [{ k_location: 'decoy' }],
    }),
    { status: 200 },
  );
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({ status: 'ok', k_log: '[9.9msb]', a_staff: { 'uid-1': {} } }),
    {
      status: 200,
    },
  );
}

/**
 * Serves the token endpoint, then the given responses to successive data calls.
 *
 * Takes FACTORIES, not Response instances. A Response body can only be read
 * once, so handing the same instance to two steps makes the second fail on a
 * consumed-body TypeError instead of on the envelope check - which would let
 * these tests pass for entirely the wrong reason.
 */
function routed(...dataResponses: Array<() => Response>) {
  let dataCall = 0;
  return vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
    const next = dataResponses[dataCall] ?? dataResponses[dataResponses.length - 1];
    dataCall += 1;
    return Promise.resolve(next === undefined ? okResponse() : next());
  });
}

/** Throttle backoff is exercised in tests/wl-retry.test.ts; here it must not wait. */
const noSleep = (): Promise<void> => Promise.resolve();

const clock = () => {
  let t = 0;
  return () => (t += 5);
};

describe('an error carried on HTTP 200 never becomes data', () => {
  it('contributes no row counts, so a writer would receive nothing to persist', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: routed(() => errorWith200()),
      now: clock(),
      sleep: noSleep,
    });

    for (const step of summary.steps) {
      expect(step.ok).toBe(false);
      // The decoy a_staff/a_location in the body must never be counted.
      expect(step.collections).toBeUndefined();
    }
  });

  it('reports the pass as not-ok, so a caller cannot read it as success', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: routed(() => errorWith200()),
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.ok).toBe(false);
    expect(summary.steps.every((s) => s.ok)).toBe(false);
  });

  it('keeps k_log and sid on the failure, so the call can be traced later', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: routed(() => errorWith200('id-empty')),
      now: clock(),
      sleep: noSleep,
    });

    const [first] = summary.steps;
    expect(first?.sid).toBe('id-empty');
    expect(first?.kLog).toBe('[12.3msb]');
    expect(first?.httpStatus).toBe(200);
  });

  it('quarantines only the failed step - a good step in the same pass still yields rows', async () => {
    const config = await loadFake();
    // Step 1 fails on a 200; steps 2 and 3 succeed.
    const summary = await runWellnessSync(config, {
      fetch: routed(
        () => errorWith200(),
        () => okResponse(),
        () => okResponse(),
      ),
      now: clock(),
      sleep: noSleep,
    });

    const [failed, ...rest] = summary.steps;
    expect(failed?.ok).toBe(false);
    expect(failed?.collections).toBeUndefined();
    expect(rest.length).toBeGreaterThan(0);
    for (const step of rest) {
      expect(step.ok).toBe(true);
      expect(step.collections).toEqual({ a_staff: 1 });
    }
    // One poisoned step still fails the pass.
    expect(summary.ok).toBe(false);
  });

  it.each([
    ['a bare non-ok status with no a_error', { status: 'id-empty' }],
    ['an empty string status', { status: '' }],
    ['a missing status field', { message: 'something happened' }],
    ['a null status', { status: null }],
    ['a numeric status', { status: 0 }],
    ['status nested where a reader might look', { data: { status: 'ok' } }],
  ])('rejects %s rather than treating it as success', async (_name, body) => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: routed(
        () => new Response(JSON.stringify({ ...body, a_staff: { 'uid-1': {} } }), { status: 200 }),
      ),
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.ok).toBe(false);
    for (const step of summary.steps) {
      expect(step.ok).toBe(false);
      expect(step.collections).toBeUndefined();
    }
  });

  it('rejects a 200 whose body is not JSON at all', async () => {
    const config = await loadFake();
    const summary = await runWellnessSync(config, {
      fetch: routed(() => new Response('<html>maintenance</html>', { status: 200 })),
      now: clock(),
      sleep: noSleep,
    });

    expect(summary.ok).toBe(false);
    expect(summary.steps.every((s) => s.collections === undefined)).toBe(true);
  });
});

/**
 * The criterion says the check must be enforced centrally "so no individual job
 * can skip it". A job skips it by calling fetch itself instead of going through
 * WlClient, so that is what this forbids - structurally, not by convention.
 */
describe('the success check cannot be bypassed', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));

  /**
   * The only modules allowed to perform an HTTP call directly.
   *
   * The rule this enforces is "nothing bypasses WlClient's status check", and
   * the allow-list is how a module that talks to something OTHER than
   * WellnessLiving declares itself - Supabase and GoHighLevel each own exactly
   * one HTTP boundary, the same way WlClient owns WL's. Adding a second file for
   * any of them is what this test is here to catch.
   */
  const ALLOWED = new Set([
    join('src', 'wl', 'client.ts'), // the WL data path - owns the status check
    join('src', 'wl', 'token.ts'), // the WL oauth2 path - no envelope to check
    join('src', 'supabase', 'health.ts'), // Supabase REST, not WL
    join('src', 'supabase', 'client.ts'), // Supabase REST writes/reads, not WL
    join('src', 'ghl', 'client.ts'), // GoHighLevel REST, not WL
  ]);

  /** An actual call site, not a `typeof globalThis.fetch` type annotation. */
  const CALL_SITE = /(?:\bdoFetch\s*\(|\bawait\s+fetch\s*\(|\bglobalThis\.fetch\s*\()/;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  it('no module outside the client performs its own WellnessLiving call', () => {
    const offenders = ['src', 'api']
      .flatMap((d) => walk(join(ROOT, d)))
      .map((file) => relative(ROOT, file))
      .filter((rel) => !ALLOWED.has(rel.split('/').join(sep)))
      .filter((rel) => CALL_SITE.test(readFileSync(join(ROOT, rel), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
