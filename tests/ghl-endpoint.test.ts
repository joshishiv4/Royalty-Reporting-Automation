import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { buildGhlUrl, GHL_PATHS } from '../src/ghl/endpoint.js';
import { FakeProvider } from './helpers/fixtures.js';

const load = (env: 'dev' | 'prod') =>
  loadConfig({ processEnv: { APP_ENV: env }, provider: new FakeProvider() });

describe('buildGhlUrl', () => {
  it('assembles the URL from the configured host, over https', async () => {
    const { ghl } = await load('prod');
    const url = new URL(buildGhlUrl(ghl, GHL_PATHS.contactsSearch));

    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(ghl.host);
    expect(url.pathname).toBe(GHL_PATHS.contactsSearch);
  });

  it('produces a different URL per environment from the same call site', async () => {
    const dev = await load('dev');
    const prod = await load('prod');

    const devUrl = buildGhlUrl(dev.ghl, GHL_PATHS.contactsSearch);
    const prodUrl = buildGhlUrl(prod.ghl, GHL_PATHS.contactsSearch);

    expect(devUrl).not.toBe(prodUrl);
    expect(new URL(devUrl).host).not.toBe(new URL(prodUrl).host);
  });

  it('rejects a path that is not rooted', async () => {
    const { ghl } = await load('dev');
    expect(() => buildGhlUrl(ghl, 'contacts/search')).toThrow(/must start with/);
  });

  it('lists only the one path the client actually needs', () => {
    // Adding a write path here is a design change, and this test exists to make
    // that visible: the number should not creep up on a whim.
    expect(Object.keys(GHL_PATHS)).toEqual(['contactsSearch']);
  });
});
