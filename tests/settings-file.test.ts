import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { FileSettingsProvider, SETTINGS_PATHS } from '../src/secrets/file-provider.js';
import { SecretsProviderError } from '../src/secrets/types.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Two complete settings files that differ in every environment coordinate. */
const FILES: Record<string, string> = {
  dev: JSON.stringify({
    environment: 'dev',
    wellnessliving: {
      host: 'wl-uat.example.test',
      authHost: 'wl-auth-uat.example.test',
      idRegion: 2,
      kBusiness: '111111',
      clientId: 'dev-client-id-0000',
      clientSecret: 'dev-client-secret-0000',
    },
    supabase: {
      url: 'https://dev-project.supabase.example.test',
      serviceRoleKey: 'dev-service-role-key-0000',
    },
    gohighlevel: {
      host: 'ghl-dev.example.test',
      version: '2021-07-28',
      apiToken: 'dev-ghl-token-0000',
      locationId: 'dev-location',
    },
  }),
  prod: JSON.stringify({
    environment: 'prod',
    wellnessliving: {
      host: 'wl-live.example.test',
      authHost: 'wl-auth-live.example.test',
      idRegion: 1,
      kBusiness: '222222',
      clientId: 'prod-client-id-0000',
      clientSecret: 'prod-client-secret-0000',
    },
    supabase: {
      url: 'https://prod-project.supabase.example.test',
      serviceRoleKey: 'prod-service-role-key-0000',
    },
    gohighlevel: {
      host: 'ghl-live.example.test',
      version: '2021-07-28',
      apiToken: 'prod-ghl-token-0000',
      locationId: 'prod-location',
    },
  }),
};

/** Serves the fixtures above without touching the filesystem. */
function provider(files: Record<string, string> = FILES): FileSettingsProvider {
  return new FileSettingsProvider({
    dir: '/settings',
    readFileImpl: (path) => {
      const env = /settings\.([a-z]+)\.json$/.exec(path)?.[1] ?? '';
      const content = files[env];
      if (content === undefined) {
        return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      }
      return Promise.resolve(content);
    },
  });
}

describe('settings file per environment', () => {
  it('switches host, region, business id and Supabase together on APP_ENV alone', async () => {
    const p = provider();
    const dev = await loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: p });
    const prod = await loadConfig({ processEnv: { APP_ENV: 'prod' }, provider: p });

    expect(dev.wl.host).toBe('wl-uat.example.test');
    expect(prod.wl.host).toBe('wl-live.example.test');
    expect(dev.wl.authHost).toBe('wl-auth-uat.example.test');
    expect(prod.wl.authHost).toBe('wl-auth-live.example.test');
    expect(dev.wl.idRegion).toBe(2);
    expect(prod.wl.idRegion).toBe(1);
    expect(dev.wl.kBusiness).not.toBe(prod.wl.kBusiness);
    expect(dev.supabase.url).not.toBe(prod.supabase.url);
    expect(dev.supabase.serviceRoleKey).not.toBe(prod.supabase.serviceRoleKey);
    expect(dev.ghl.apiToken).not.toBe(prod.ghl.apiToken);
  });

  it('accepts a numeric idRegion and still exposes k_business as text', async () => {
    const config = await loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: provider() });
    expect(config.wl.idRegion).toBe(2);
    expect(config.wl.kBusiness).toBe('111111');
    expect(typeof config.wl.kBusiness).toBe('string');
  });

  it('resolves one path per environment', () => {
    const p = new FileSettingsProvider({ dir: '/settings' });
    expect(p.settingsPath('dev')).toMatch(/settings\.dev\.json$/);
    expect(p.settingsPath('prod')).toMatch(/settings\.prod\.json$/);
  });
});

describe('settings file failures are actionable at startup', () => {
  it('names the expected path and the copy command when the file is absent', async () => {
    const error = await provider({})
      .load('prod')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretsProviderError);
    const message = (error as Error).message;
    expect(message).toContain('settings.prod.json');
    expect(message).toContain('cp config/settings.example.json');
    expect(message).toContain('APP_ENV="prod"');
  });

  it('explains malformed JSON instead of throwing a parser stack', async () => {
    const error = await provider({ dev: '{ "wellnessliving": { "host": "x", } }' })
      .load('dev')
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/not valid JSON/);
    expect((error as Error).message).toMatch(/trailing comma/);
  });

  it('fails loudly on a mistyped section rather than reading it as absent', async () => {
    const error = await provider({ dev: JSON.stringify({ wellnessLiving: { host: 'x' } }) })
      .load('dev')
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/unrecognised section/);
    expect((error as Error).message).toContain('wellnessLiving');
  });

  it('rejects a structural value where a setting belongs', async () => {
    const error = await provider({ dev: JSON.stringify({ supabase: { url: { a: 1 } } }) })
      .load('dev')
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/supabase\.url .* must be a string/);
  });

  it('reports every unfilled placeholder in the committed example', async () => {
    const example = readFileSync(`${ROOT}config/settings.example.json`, 'utf8');
    const error = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: provider({ dev: example }),
    }).catch((e: unknown) => e);

    // Copying the example and running immediately must fail at startup with a
    // list of what to fill in - never proceed to a first API call.
    const message = (error as Error).message;
    expect(message).toMatch(/placeholder/);
    for (const key of ['WL_API_HOST', 'SUPABASE_URL', 'GHL_API_TOKEN']) {
      expect(message).toContain(key);
    }
  });
});

describe('the committed example file', () => {
  const example = readFileSync(`${ROOT}config/settings.example.json`, 'utf8');

  it('is valid JSON and documents every setting the app requires', () => {
    const parsed = JSON.parse(example) as Record<string, Record<string, unknown>>;
    for (const dotted of Object.keys(SETTINGS_PATHS)) {
      const [section, field] = dotted.split('.') as [string, string];
      expect(parsed[section], `missing section ${section}`).toBeDefined();
      expect(parsed[section]?.[field], `missing ${dotted}`).toBeDefined();
    }
  });

  it('contains only placeholders - no real value', () => {
    for (const value of Object.values(JSON.parse(example) as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      for (const setting of Object.values(value as Record<string, unknown>)) {
        expect(setting).toBe('FILL_ME');
      }
    }
  });

  it('is the only settings file git will ever track', () => {
    // Guards the acceptance criterion directly: real settings files must be
    // ignored, the example must not be.
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', path], { cwd: ROOT });
        return true;
      } catch {
        return false;
      }
    };

    expect(ignored('config/settings.dev.json')).toBe(true);
    expect(ignored('config/settings.prod.json')).toBe(true);
    expect(ignored('config/settings.example.json')).toBe(false);
  });
});
