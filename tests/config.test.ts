import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { ConfigValidationError } from '../src/config/schema.js';
import { MissingSecretsError } from '../src/secrets/types.js';
import { FAKE_BUNDLES, FakeProvider, StaticProvider } from './helpers/fixtures.js';

describe('loadConfig', () => {
  it('switches host, region and business id when APP_ENV changes', async () => {
    const provider = new FakeProvider();

    const dev = await loadConfig({ processEnv: { APP_ENV: 'dev' }, provider });
    const prod = await loadConfig({ processEnv: { APP_ENV: 'prod' }, provider });

    // The acceptance criterion: one env var, three different values, no code change.
    expect(dev.wl.host).not.toBe(prod.wl.host);
    expect(dev.wl.idRegion).not.toBe(prod.wl.idRegion);
    expect(dev.wl.kBusiness).not.toBe(prod.wl.kBusiness);
    expect(dev.supabase.url).not.toBe(prod.supabase.url);
    expect(provider.calls).toEqual(['dev', 'prod']);
  });

  it('derives baseUrl as https from the bare host', async () => {
    const config = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: new FakeProvider(),
    });
    expect(config.wl.baseUrl).toBe(`https://${FAKE_BUNDLES.dev.WL_API_HOST}`);
  });

  it('keeps k_business as text and id_region as a number', async () => {
    const config = await loadConfig({
      processEnv: { APP_ENV: 'prod' },
      provider: new FakeProvider(),
    });
    expect(typeof config.wl.kBusiness).toBe('string');
    expect(typeof config.wl.idRegion).toBe('number');
  });

  it('rejects an unknown or missing APP_ENV', async () => {
    await expect(loadConfig({ processEnv: {}, provider: new FakeProvider() })).rejects.toThrow(
      ConfigValidationError,
    );
    await expect(
      loadConfig({ processEnv: { APP_ENV: 'staging' }, provider: new FakeProvider() }),
    ).rejects.toThrow(/APP_ENV/);
  });

  it('lists every missing key instead of failing on the first', async () => {
    const partial = { ...FAKE_BUNDLES.dev };
    delete (partial as Record<string, unknown>).WL_K_BUSINESS;
    delete (partial as Record<string, unknown>).GHL_API_TOKEN;

    const error = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: new StaticProvider(partial),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingSecretsError);
    expect((error as MissingSecretsError).missing).toEqual(['WL_K_BUSINESS', 'GHL_API_TOKEN']);
  });

  it('rejects a host that carries a scheme or a path', async () => {
    for (const host of ['https://wl.example.test', 'wl.example.test/v1', 'wl.example.test/']) {
      const error = await loadConfig({
        processEnv: { APP_ENV: 'dev' },
        provider: new StaticProvider({ ...FAKE_BUNDLES.dev, WL_API_HOST: host }),
      }).catch((e: unknown) => e);
      expect(error, host).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('WL_API_HOST');
    }
  });

  it('rejects a non-numeric region and a non-numeric business key', async () => {
    await expect(
      loadConfig({
        processEnv: { APP_ENV: 'dev' },
        provider: new StaticProvider({ ...FAKE_BUNDLES.dev, WL_ID_REGION: 'two' }),
      }),
    ).rejects.toThrow(/WL_ID_REGION/);

    await expect(
      loadConfig({
        processEnv: { APP_ENV: 'dev' },
        provider: new StaticProvider({ ...FAKE_BUNDLES.dev, WL_K_BUSINESS: 'abc' }),
      }),
    ).rejects.toThrow(/WL_K_BUSINESS/);
  });

  it('rejects a value still left as an .env.example placeholder', async () => {
    const error = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: new StaticProvider({
        ...FAKE_BUNDLES.dev,
        SUPABASE_SERVICE_ROLE_KEY: '<supabase-service-role-key>',
      }),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).message).toMatch(/placeholder/);
  });

  it.each(['FILL_ME', 'TODO', 'CHANGEME', '<wl-k-business>'])(
    'names %s as an unfilled placeholder rather than a format error',
    async (marker) => {
      const error = await loadConfig({
        processEnv: { APP_ENV: 'dev' },
        provider: new StaticProvider({ ...FAKE_BUNDLES.dev, WL_K_BUSINESS: marker }),
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toMatch(/WL_K_BUSINESS.*placeholder/);
    },
  );

  it('never echoes a rejected value in the error message', async () => {
    const secret = 'a-real-looking-secret-value';
    const error = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: new StaticProvider({ ...FAKE_BUNDLES.dev, WL_ID_REGION: secret }),
    }).catch((e: unknown) => e);

    expect((error as Error).message).not.toContain(secret);
  });

  it('applies runtime defaults and honours overrides', async () => {
    const defaults = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: new FakeProvider(),
    });
    expect(defaults.runtime).toMatchObject({
      logLevel: 'info',
      maxConcurrency: 5,
    });

    const tuned = await loadConfig({
      processEnv: {
        APP_ENV: 'dev',
        LOG_LEVEL: 'debug',
        WL_MAX_CONCURRENCY: '2',
      },
      provider: new FakeProvider(),
    });
    expect(tuned.runtime).toMatchObject({
      logLevel: 'debug',
      maxConcurrency: 2,
    });
  });

  it('treats an unset, empty or whitespace SMTP_HOST as notifications OFF', async () => {
    // The empty case is the one that bites. `vercel env add SMTP_HOST <env>`
    // with a blank value prompt stores "", and an empty string that reaches
    // `smtp.host` as "" rather than null makes the notifier believe it is
    // configured - so every run opens a connection to nowhere. Whitespace is
    // the same mistake with a space bar involved.
    for (const SMTP_HOST of [undefined, '', '   ']) {
      const config = await loadConfig({
        processEnv: { APP_ENV: 'dev', ...(SMTP_HOST === undefined ? {} : { SMTP_HOST }) },
        provider: new FakeProvider(),
      });
      expect(config.smtp.host).toBeNull();
    }
  });

  it('switches notifications on when SMTP_HOST has a value', async () => {
    const config = await loadConfig({
      processEnv: { APP_ENV: 'dev', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465' },
      provider: new FakeProvider(),
    });
    expect(config.smtp.host).toBe('smtp.example.test');
    expect(config.smtp.port).toBe(465);
    // Recipient survives with no env var at all - a fresh install still reaches
    // somebody rather than silently mailing nobody.
    expect(config.smtp.to.length).toBeGreaterThan(0);
  });

  it('returns a frozen config so nothing can mutate it mid-run', async () => {
    const config = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: new FakeProvider(),
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.wl)).toBe(true);
  });
});
