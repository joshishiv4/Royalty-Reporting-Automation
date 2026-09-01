import {
  createSecretsProvider,
  isSecretsProviderKind,
  SECRETS_PROVIDER_KINDS,
  type SecretsProviderKind,
} from '../secrets/index.js';
import {
  MissingSecretsError,
  SECRET_KEYS,
  SecretsProviderError,
  type AppEnv,
  type SecretsProvider,
} from '../secrets/types.js';
import {
  appEnvSchema,
  ConfigValidationError,
  formatIssues,
  runtimeOptionsSchema,
  secretBundleSchema,
  type AppConfig,
} from './schema.js';

export * from './schema.js';

export interface LoadConfigInput {
  /** Bootstrap environment. Only APP_ENV / SECRETS_PROVIDER / tuning are read here. */
  processEnv?: Readonly<Record<string, string | undefined>>;
  /** Inject a provider directly (tests, or a backend chosen by the caller). */
  provider?: SecretsProvider;
}

/**
 * Resolves the full application configuration at startup.
 *
 * Order of operations:
 *   1. read APP_ENV                  -> which environment bundle to load
 *   2. read SECRETS_PROVIDER         -> where to load it from
 *   3. provider.load(env)            -> the bundle
 *   4. validate every required key    -> fail fast, listing what is missing
 *
 * Nothing here contains a host, region, business id or credential. Pointing
 * APP_ENV at the other environment yields a different host, region and business
 * id with no code change.
 */
export async function loadConfig(input: LoadConfigInput = {}): Promise<AppConfig> {
  const processEnv = input.processEnv ?? process.env;

  const env = parseAppEnv(processEnv.APP_ENV);
  const provider =
    input.provider ??
    createSecretsProvider({ kind: parseProviderKind(processEnv.SECRETS_PROVIDER), processEnv });

  const bundle = await provider.load(env);

  const missing = SECRET_KEYS.filter((key) => bundle[key] === undefined);
  if (missing.length > 0) {
    throw new MissingSecretsError(provider.name, env, missing);
  }

  const secrets = secretBundleSchema.safeParse(bundle);
  if (!secrets.success) {
    throw new ConfigValidationError(formatIssues(secrets.error));
  }

  const runtime = runtimeOptionsSchema.safeParse({
    LOG_LEVEL: processEnv.LOG_LEVEL,
    WL_MAX_CONCURRENCY: processEnv.WL_MAX_CONCURRENCY,
    HTTP_TIMEOUT_MS: processEnv.HTTP_TIMEOUT_MS,
    LOG_TO_FILE: processEnv.LOG_TO_FILE,
    LOG_DIR: processEnv.LOG_DIR,
    SYNC_HISTORY_START: processEnv.SYNC_HISTORY_START,
    SYNC_MONTHLY_LOOKBACK_MONTHS: processEnv.SYNC_MONTHLY_LOOKBACK_MONTHS,
    SYNC_DAILY_LOOKBACK_DAYS: processEnv.SYNC_DAILY_LOOKBACK_DAYS,
    SMTP_HOST: processEnv.SMTP_HOST,
    SMTP_PORT: processEnv.SMTP_PORT,
    SMTP_USER: processEnv.SMTP_USER,
    SMTP_PASSWORD: processEnv.SMTP_PASSWORD,
    SMTP_FROM: processEnv.SMTP_FROM,
    SMTP_TO: processEnv.SMTP_TO,
  });
  if (!runtime.success) {
    throw new ConfigValidationError(formatIssues(runtime.error));
  }

  const s = secrets.data;
  return Object.freeze({
    env,
    secretsProviderName: provider.name,
    wl: Object.freeze({
      host: s.WL_API_HOST,
      baseUrl: `https://${s.WL_API_HOST}`,
      authHost: s.WL_AUTH_HOST,
      authBaseUrl: `https://${s.WL_AUTH_HOST}`,
      idRegion: s.WL_ID_REGION,
      kBusiness: s.WL_K_BUSINESS,
      clientId: s.WL_CLIENT_ID,
      clientSecret: s.WL_CLIENT_SECRET,
    }),
    supabase: Object.freeze({
      url: s.SUPABASE_URL,
      serviceRoleKey: s.SUPABASE_SERVICE_ROLE_KEY,
    }),
    ghl: Object.freeze({
      host: s.GHL_API_HOST,
      baseUrl: `https://${s.GHL_API_HOST}`,
      version: s.GHL_API_VERSION,
      apiToken: s.GHL_API_TOKEN,
      locationId: s.GHL_LOCATION_ID,
    }),
    runtime: Object.freeze({
      logLevel: runtime.data.LOG_LEVEL,
      maxConcurrency: runtime.data.WL_MAX_CONCURRENCY,
      httpTimeoutMs: runtime.data.HTTP_TIMEOUT_MS,
      logToFile: runtime.data.LOG_TO_FILE,
      logDir: runtime.data.LOG_DIR,
    }),
    sync: Object.freeze({
      historyStart: runtime.data.SYNC_HISTORY_START,
      dailyLookbackDays: runtime.data.SYNC_DAILY_LOOKBACK_DAYS,
      monthlyLookbackMonths: runtime.data.SYNC_MONTHLY_LOOKBACK_MONTHS,
    }),
    smtp: Object.freeze({
      host: runtime.data.SMTP_HOST ?? null,
      port: runtime.data.SMTP_PORT ?? 587,
      user: runtime.data.SMTP_USER ?? '',
      password: runtime.data.SMTP_PASSWORD ?? '',
      from: runtime.data.SMTP_FROM ?? '',
      to: runtime.data.SMTP_TO,
    }),
  });
}

function parseAppEnv(raw: string | undefined): AppEnv {
  const parsed = appEnvSchema.safeParse(raw?.trim());
  if (!parsed.success) {
    throw new ConfigValidationError([
      `APP_ENV: must be one of dev, prod (received ${raw === undefined ? 'nothing' : 'an unrecognised value'})`,
    ]);
  }
  return parsed.data;
}

function parseProviderKind(raw: string | undefined): SecretsProviderKind {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return 'env';
  if (!isSecretsProviderKind(value)) {
    throw new SecretsProviderError(
      'config',
      `SECRETS_PROVIDER must be one of: ${SECRETS_PROVIDER_KINDS.join(', ')}`,
    );
  }
  return value;
}
