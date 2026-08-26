/**
 * Secret + per-environment configuration keys.
 *
 * Everything in this file is a KEY NAME. No value for any of these keys may
 * ever appear in this repository - not a host, not a region, not a business id,
 * not a credential. They are resolved at startup by a SecretsProvider.
 */

/** The two environments the sync service runs in. */
export const APP_ENVS = ['dev', 'prod'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/**
 * Every key the application resolves from the secrets manager.
 *
 * WL_API_HOST, WL_AUTH_HOST, WL_ID_REGION and WL_K_BUSINESS are deliberately in
 * here rather than in source: they differ between dev and prod (architecture doc
 * section 2a), and hardcoding them is a named project risk.
 *
 * WL_AUTH_HOST is separate from WL_API_HOST because WL serves /oauth2/token from
 * a different host than the data endpoints. Pointing the token request at the
 * data host returns a challenge page, not a token.
 */
export const SECRET_KEYS = [
  'WL_API_HOST',
  'WL_AUTH_HOST',
  'WL_ID_REGION',
  'WL_K_BUSINESS',
  'WL_CLIENT_ID',
  'WL_CLIENT_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  // GoHighLevel. GHL_API_HOST is per-environment for the same reason WL_API_HOST
  // is: hardcoding it is a named project risk. GHL_API_VERSION is stored beside
  // it so the date-stamped API contract that this client parses moves with the
  // config bundle; a schema-shape change is a coordinated code+config bump, not
  // a code deploy the config side sleeps through.
  'GHL_API_HOST',
  'GHL_API_VERSION',
  'GHL_API_TOKEN',
  'GHL_LOCATION_ID',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

/**
 * The subset that is an actual credential: must be redacted from every log line
 * and is covered by the rotation procedure in the runbook. The remaining keys
 * are environment coordinates - sensitive, but not rotatable secrets.
 */
export const CREDENTIAL_KEYS = [
  'WL_CLIENT_ID',
  'WL_CLIENT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GHL_API_TOKEN',
] as const satisfies readonly SecretKey[];

export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

export function isCredentialKey(key: string): key is CredentialKey {
  return (CREDENTIAL_KEYS as readonly string[]).includes(key);
}

/** A raw, unvalidated bundle as returned by a provider. */
export type SecretBundle = Partial<Record<SecretKey, string>>;

/**
 * A source of secrets. Implementations must not log values, and one provider
 * instance serves one AppEnv - never cache a bundle across environments.
 */
export interface SecretsProvider {
  /** Stable identifier used in logs and health output. */
  readonly name: string;
  /** Resolve the bundle for env. Missing keys are omitted, not empty-strung. */
  load(env: AppEnv): Promise<SecretBundle>;
}

/** Thrown when a provider cannot supply keys the application requires. */
export class MissingSecretsError extends Error {
  constructor(
    readonly providerName: string,
    readonly env: AppEnv,
    readonly missing: readonly string[],
  ) {
    super(
      `Missing ${missing.length} required key(s) for env "${env}" from provider ` +
        `"${providerName}": ${missing.join(', ')}. See .env.example and ` +
        'docs/RUNBOOK.md',
    );
    this.name = 'MissingSecretsError';
  }
}

/** Thrown when a provider itself is unusable (bad config, unreachable, denied). */
export class SecretsProviderError extends Error {
  constructor(
    readonly providerName: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${providerName}] ${message}`, options);
    this.name = 'SecretsProviderError';
  }
}
