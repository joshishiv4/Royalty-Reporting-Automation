import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { GhlConfig } from '../src/config/schema.js';
import { GhlClient, GhlRequestError } from '../src/ghl/client.js';
import { FakeProvider } from './helpers/fixtures.js';

async function ghlConfig(): Promise<GhlConfig> {
  const config = await loadConfig({
    processEnv: { APP_ENV: 'dev' },
    provider: new FakeProvider(),
  });
  return config.ghl;
}

function calledUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return '';
}

function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error('expected JSON string body in fetch init');
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function sentHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function contactsResponse(contacts: Array<Record<string, unknown>>): Response {
  return jsonResponse({ contacts, total: contacts.length });
}

const noSleep = (): Promise<void> => Promise.resolve();
const clock = () => {
  let t = 0;
  return () => (t += 5);
};

describe('GhlClient - authenticated contact search', () => {
  it('sends the bearer token, the Version header, and the location on every call', async () => {
    const ghl = await ghlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(contactsResponse([])));
    const client = new GhlClient(ghl, { fetch: fetchMock, now: clock() });

    await client.searchContacts({ email: 'someone@example.test' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = sentHeaders(init);
    expect(headers.get('authorization')).toBe(`Bearer ${ghl.apiToken}`);
    expect(headers.get('version')).toBe(ghl.version);
    expect(headers.get('content-type')).toBe('application/json');

    // The shape GHL actually accepts - see the body-shape describe below. A flat
    // {locationId, email} is rejected 422, which this test used to assert.
    expect(sentBody(init)).toEqual({
      locationId: ghl.locationId,
      pageLimit: 20,
      filters: [{ field: 'email', operator: 'eq', value: 'someone@example.test' }],
    });
  });

  it('routes to the search path on the configured host', async () => {
    const ghl = await ghlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(contactsResponse([])));
    const client = new GhlClient(ghl, { fetch: fetchMock, now: clock() });

    await client.searchContacts({ phone: '+15555550100' });

    const url = new URL(calledUrl(fetchMock.mock.calls[0]![0]));
    expect(url.host).toBe(ghl.host);
    expect(url.pathname).toBe('/contacts/search');
    expect(url.protocol).toBe('https:');
  });

  it('parses contacts, preserving every field as raw', async () => {
    const ghl = await ghlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        contactsResponse([
          {
            id: 'c1',
            locationId: ghl.locationId,
            email: 'a@example.test',
            phone: '+15555550101',
            firstName: 'A',
            lastName: 'B',
            tags: ['vip'],
          },
        ]),
      ),
    );
    const client = new GhlClient(ghl, { fetch: fetchMock, now: clock() });

    const result = await client.searchContacts({ email: 'a@example.test' });

    expect(result.contacts).toHaveLength(1);
    const [c] = result.contacts;
    expect(c?.id).toBe('c1');
    expect(c?.email).toBe('a@example.test');
    expect(c?.phone).toBe('+15555550101');
    expect(c?.raw.tags).toEqual(['vip']);
  });

  it('refuses an unfiltered search rather than enumerating the location', async () => {
    const ghl = await ghlConfig();
    const client = new GhlClient(ghl, { fetch: vi.fn(), now: clock() });

    // The runtime guard exists for a JS caller that bypasses the types; the
    // types themselves already accept an empty object because both fields are
    // optional, so no cast is needed here.
    await expect(client.searchContacts({})).rejects.toThrow(/at least one/i);
  });
});

describe('GhlClient - failure classification', () => {
  it('401 is auth and does not retry', async () => {
    const ghl = await ghlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ message: 'invalid token' }, 401)),
    );
    const client = new GhlClient(ghl, {
      fetch: fetchMock,
      now: clock(),
      sleep: noSleep,
    });

    await expect(client.searchContacts({ email: 'a@example.test' })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('403 is also auth (PIT tokens are location-scoped)', async () => {
    const ghl = await ghlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ message: 'forbidden' }, 403)),
    );
    const client = new GhlClient(ghl, { fetch: fetchMock, now: clock(), sleep: noSleep });

    await expect(client.searchContacts({ email: 'a@example.test' })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('400 is permanent and does not retry - a bad parameter stays bad', async () => {
    const ghl = await ghlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ message: 'bad' }, 400)),
    );
    const client = new GhlClient(ghl, { fetch: fetchMock, now: clock(), sleep: noSleep });

    await expect(client.searchContacts({ email: 'a@example.test' })).rejects.toMatchObject({
      kind: 'permanent',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('honours Retry-After when the server sends one and it fits the step', async () => {
    const ghl = await ghlConfig();
    let call = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>(() => {
      call += 1;
      if (call === 1) return Promise.resolve(jsonResponse({}, 429, { 'retry-after': '2' }));
      return Promise.resolve(contactsResponse([]));
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const client = new GhlClient(ghl, {
      fetch: fetchMock,
      now: clock(),
      sleep,
      random: () => 0,
    });

    await client.searchContacts({ email: 'a@example.test' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('surfaces a too-long Retry-After without stalling in-process', async () => {
    const ghl = await ghlConfig();
    // 3600s is inside parseRetryAfter's ceiling but far past the in-process cap.
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({}, 429, { 'retry-after': '3600' })),
    );
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const client = new GhlClient(ghl, {
      fetch: fetchMock,
      now: clock(),
      sleep,
      random: () => 0,
    });

    await expect(client.searchContacts({ email: 'a@example.test' })).rejects.toMatchObject({
      kind: 'transient',
      details: { httpStatus: 429, retryAfterMs: 3_600_000 },
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('backs off on 5xx without a Retry-After, then succeeds', async () => {
    const ghl = await ghlConfig();
    let call = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>(() => {
      call += 1;
      if (call === 1) return Promise.resolve(jsonResponse({ message: 'boom' }, 503));
      return Promise.resolve(contactsResponse([]));
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const client = new GhlClient(ghl, {
      fetch: fetchMock,
      now: clock(),
      sleep,
      random: () => 0,
    });

    const result = await client.searchContacts({ email: 'a@example.test' });
    expect(result.contacts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Backoff must be a ladder rung, not zero.
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('gives up after the ladder is spent, marking the failure transient', async () => {
    const ghl = await ghlConfig();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ message: 'boom' }, 502)),
    );
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const client = new GhlClient(ghl, {
      fetch: fetchMock,
      now: clock(),
      sleep,
      random: () => 0,
    });

    try {
      await client.searchContacts({ email: 'a@example.test' });
      expect.unreachable('call should have failed');
    } catch (cause) {
      expect(cause).toBeInstanceOf(GhlRequestError);
      expect((cause as GhlRequestError).kind).toBe('transient');
      // Four attempts: the original plus one for each rung of the 3-rung ladder.
      expect((cause as GhlRequestError).details.attempts).toBe(4);
    }
  });
});

describe('the search body shape GHL actually accepts', () => {
  /**
   * Probed live 26 Aug 2026. The obvious body - {locationId, email} - is
   * rejected 422 with GHL naming both faults itself:
   *   "property email should not exist"
   *   "pageLimit must be a number conforming to the specified constraints"
   * These tests exist so that shape cannot quietly come back.
   */
  function bodyOf(sent: { body?: string | null }): Record<string, unknown> {
    return JSON.parse(String(sent.body ?? '{}')) as Record<string, unknown>;
  }

  function captureFetch() {
    const seen: Array<{ body?: string | null }> = [];
    const doFetch = vi.fn((_url: string, init: { body?: string | null }) => {
      seen.push(init);
      return Promise.resolve(
        new Response(JSON.stringify({ contacts: [], total: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    return { seen, doFetch: doFetch as unknown as typeof globalThis.fetch };
  }

  it('puts a term in a filters ARRAY, never as a top-level property', async () => {
    const { seen, doFetch } = captureFetch();
    await new GhlClient(await ghlConfig(), { fetch: doFetch }).searchContacts({ email: 'a@b.com' });

    const body = bodyOf(seen[0]!);
    expect(body).not.toHaveProperty('email');
    expect(body.filters).toEqual([{ field: 'email', operator: 'eq', value: 'a@b.com' }]);
  });

  // Omitting this fails the request outright, even with nothing to filter on.
  it('always sends a numeric pageLimit', async () => {
    const { seen, doFetch } = captureFetch();
    await new GhlClient(await ghlConfig(), { fetch: doFetch }).searchContacts({ email: 'a@b.com' });

    expect(typeof bodyOf(seen[0]!).pageLimit).toBe('number');
  });

  it('sends the location the token is scoped to', async () => {
    const { seen, doFetch } = captureFetch();
    await new GhlClient(await ghlConfig(), { fetch: doFetch }).searchContacts({
      phone: '+15551234567',
    });

    expect(bodyOf(seen[0]!).locationId).toBe((await ghlConfig()).locationId);
  });

  it('filters on phone the same way', async () => {
    const { seen, doFetch } = captureFetch();
    await new GhlClient(await ghlConfig(), { fetch: doFetch }).searchContacts({
      phone: '+15551234567',
    });

    expect(bodyOf(seen[0]!).filters).toEqual([
      { field: 'phone', operator: 'eq', value: '+15551234567' },
    ]);
  });
});
