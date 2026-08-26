/** Public surface of the sync service foundation layer. */

export { loadConfig, type LoadConfigInput } from './config/index.js';
export type {
  AppConfig,
  GhlConfig,
  LogLevel,
  RuntimeConfig,
  SupabaseConfig,
  WlConfig,
} from './config/schema.js';
export { ConfigValidationError } from './config/schema.js';

export { createLogger, type Logger } from './logging/logger.js';
export { createDefaultFileSinks, createFileSink, type LogSink } from './logging/file-sink.js';
export {
  credentialValues,
  describeConfig,
  fingerprint,
  redact,
  REDACTED,
} from './logging/redact.js';

export {
  createSecretsProvider,
  isSecretsProviderKind,
  SECRETS_PROVIDER_KINDS,
  type SecretsProviderKind,
} from './secrets/index.js';
export {
  APP_ENVS,
  CREDENTIAL_KEYS,
  MissingSecretsError,
  SECRET_KEYS,
  SecretsProviderError,
  type AppEnv,
  type SecretBundle,
  type SecretKey,
  type SecretsProvider,
} from './secrets/types.js';

export { checkAll, type HealthCheckResult, type HealthProbeDeps } from './health/index.js';
export { checkSupabaseReachable } from './supabase/health.js';
export {
  WlClient,
  WlRequestError,
  type WlClientDeps,
  type WlErrorDetails,
  type WlFailureKind,
  type WlRequestOptions,
  type WlResponse,
} from './wl/client.js';
export { buildWlAuthUrl, buildWlUrl, WL_PATHS, type WlPathName } from './wl/endpoint.js';
export {
  runWellnessSync,
  type WellnessSyncDeps,
  type WellnessSyncStep,
  type WellnessSyncSummary,
} from './wl/sync.js';
export { isAuthorized, isAuthorizedByAny } from './http/bearer.js';
export type { HttpRequest, HttpResponse } from './http/types.js';
export { checkWlAuth, type WlHealthDeps } from './wl/health.js';
export {
  WlAuthError,
  WlTokenClient,
  type WlAuthFailureKind,
  type WlTokenClientDeps,
  type WlTokenStatus,
} from './wl/token.js';
export {
  GhlClient,
  GhlRequestError,
  type ContactSearchFilters,
  type GhlClientDeps,
  type GhlContact,
  type GhlErrorDetails,
  type GhlFailureKind,
  type GhlSearchResponse,
} from './ghl/client.js';
export { buildGhlUrl, GHL_PATHS, type GhlPathName } from './ghl/endpoint.js';
export { checkGhlAuth, type GhlHealthDeps } from './ghl/health.js';
