import type { AppEnv, SecretBundle, SecretsProvider } from '../../src/secrets/types.js';

/**
 * Two complete, obviously-fake bundles that differ in host, region and business
 * id - which is exactly the property the environment-switching test asserts.
 */
export const FAKE_BUNDLES: Record<AppEnv, Required<SecretBundle>> = {
  dev: {
    WL_API_HOST: 'wl-dev.example.test',
    WL_AUTH_HOST: 'wl-auth-dev.example.test',
    WL_ID_REGION: '2',
    WL_K_BUSINESS: '111111',
    WL_CLIENT_ID: 'dev-client-id-0000',
    WL_CLIENT_SECRET: 'dev-client-secret-0000',
    SUPABASE_URL: 'https://dev-project.supabase.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'dev-service-role-key-0000',
    GHL_API_HOST: 'ghl-dev.example.test',
    GHL_API_VERSION: '2021-07-28',
    GHL_API_TOKEN: 'dev-ghl-token-0000',
    GHL_LOCATION_ID: 'dev-location',
  },
  prod: {
    WL_API_HOST: 'wl-prod.example.test',
    WL_AUTH_HOST: 'wl-auth-prod.example.test',
    WL_ID_REGION: '1',
    WL_K_BUSINESS: '222222',
    WL_CLIENT_ID: 'prod-client-id-0000',
    WL_CLIENT_SECRET: 'prod-client-secret-0000',
    SUPABASE_URL: 'https://prod-project.supabase.example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'prod-service-role-key-0000',
    GHL_API_HOST: 'ghl-prod.example.test',
    GHL_API_VERSION: '2021-07-28',
    GHL_API_TOKEN: 'prod-ghl-token-0000',
    GHL_LOCATION_ID: 'prod-location',
  },
};

/** A provider that serves FAKE_BUNDLES, i.e. a real per-environment backend. */
export class FakeProvider implements SecretsProvider {
  readonly name = 'fake';
  readonly calls: AppEnv[] = [];

  constructor(private readonly overrides: Partial<Record<AppEnv, SecretBundle>> = {}) {}

  load(env: AppEnv): Promise<SecretBundle> {
    this.calls.push(env);
    return Promise.resolve({ ...FAKE_BUNDLES[env], ...(this.overrides[env] ?? {}) });
  }
}

/** A provider that returns exactly what it is given, for validation tests. */
export class StaticProvider implements SecretsProvider {
  readonly name = 'static';
  constructor(private readonly bundle: SecretBundle) {}
  load(): Promise<SecretBundle> {
    return Promise.resolve(this.bundle);
  }
}
