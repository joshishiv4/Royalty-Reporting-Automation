import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { checkGhlAuth } from '../src/ghl/health.js';
import { FakeProvider } from './helpers/fixtures.js';

const load = () => loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: new FakeProvider() });

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('checkGhlAuth', () => {
  it('reports ok when the token is accepted', async () => {
    const { ghl, env } = await load();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(response({ contacts: [], total: 0 })),
    );

    const result = await checkGhlAuth(ghl, { fetch: fetchMock, env });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('ghl:contacts-search');
    expect(result.httpStatus).toBe(200);
  });

  it('reports failure with the classifier verdict when the token is rejected', async () => {
    const { ghl, env } = await load();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(response({ message: 'invalid' }, 401)),
    );

    const result = await checkGhlAuth(ghl, { fetch: fetchMock, env });

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(401);
    expect(result.detail).toMatch(/env "dev"/);
  });

  it('probes with a synthetic address, never anyone real', async () => {
    const { ghl } = await load();
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(response({ contacts: [], total: 0 })),
    );

    await checkGhlAuth(ghl, { fetch: fetchMock });

    const [, init] = fetchMock.mock.calls[0]!;
    const bodyStr: unknown = init?.body;
    if (typeof bodyStr !== 'string') throw new Error('expected JSON string body');
    const body = JSON.parse(bodyStr) as { filters?: Array<{ field?: string; value?: unknown }> };
    // The probe address lives inside the filters array - GHL rejects a flat
    // {locationId, email} body outright (see the body-shape tests).
    const emailTerm = (body.filters ?? []).find((f) => f.field === 'email');
    const email = typeof emailTerm?.value === 'string' ? emailTerm.value : '';
    expect(email).toContain('healthcheck+');
    expect(email).toContain('.invalid');
  });
});
