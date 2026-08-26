import { z } from 'zod';
import { APP_ENVS, type AppEnv } from '../secrets/types.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Markers used in .env.example and the local .env scaffold.
 *
 * Detected before any other rule so an unfilled slot is reported as "not filled
 * in yet" rather than as some incidental format failure.
 */
const PLACEHOLDER_PATTERN = /^(<.*>|FILL_ME|TODO|CHANGEME|X{3,}|\.{3})$/i;

const PLACEHOLDER_MESSAGE =
  'is still a placeholder - fill it in from the secrets manager (see docs/RUNBOOK.md)';

/**
 * A string that has actually been filled in. Innermost rule, so it runs first,
 * and the issue is fatal so an unfilled key reports once instead of also
 * failing every format rule downstream of it.
 */
const filledIn = z
  .string()
  // Trimmed before any other rule: a value that arrives with stray whitespace -
  // a copy-paste artefact, or a CRLF line ending in a hand-edited settings file
  // - must be judged on its content. Every provider trims as well; this is the
  // backstop for a future one that forgets.
  .transform((value) => value.trim())
  .superRefine((value, ctx) => {
    if (value.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not be empty', fatal: true });
      return z.NEVER;
    }
    if (PLACEHOLDER_PATTERN.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PLACEHOLDER_MESSAGE, fatal: true });
      return z.NEVER;
    }
    return undefined;
  });

/**
 * A bare hostname: no scheme, no path, no trailing slash, no query.
 *
 * The scheme is added by the URL builder so a misconfigured value cannot
 * silently downgrade calls to http.
 */
const bareHost = filledIn
  .refine((v) => !v.includes('://'), { message: 'must not include a scheme (no "https://")' })
  .refine((v) => !v.includes('/'), {
    message: 'must be a bare host with no path or trailing slash',
  })
  .refine((v) => !/\s/.test(v), { message: 'must not contain whitespace' })
  .refine((v) => /^[a-z0-9.-]+$/i.test(v), { message: 'is not a valid hostname' });

/** WL region ids are small positive integers; they arrive as strings. */
const positiveIntFromString = filledIn
  .refine((v) => /^\d+$/.test(v), { message: 'must be a whole number' })
  .transform((v) => Number.parseInt(v, 10))
  .refine((v) => v > 0, { message: 'must be greater than zero' });

/**
 * WL `k_` keys are stored and transmitted as text everywhere, never as numbers
 * (PRD M02). Validated as digits but kept a string.
 */
const wlKey = filledIn.refine((v) => /^\d+$/.test(v), {
  message: 'must be a numeric key expressed as text',
});

const httpsUrl = filledIn
  .refine((v) => v.startsWith('https://'), { message: 'must start with https://' })
  .refine(
    (v) => {
      try {
        new URL(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'is not a valid URL' },
  )
  .transform((v) => v.replace(/\/+$/, ''));

/**
 * A flag written the way an env file writes one.
 *
 * Accepts the four spellings people actually type. Anything else is rejected
 * rather than silently read as false: a typo that quietly disables logging is
 * the kind of thing only noticed when the log is needed.
 */
const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const opaqueSecret = filledIn.refine((v) => v.length >= 8, {
  message: 'is too short to be a real credential',
});

/**
 * GoHighLevel's date-stamped API version, e.g. 2021-07-28.
 *
 * Shape-checked, not value-checked: a typo like "2021-7-28" (single-digit month)
 * fails here rather than at the first live call, where it comes back as an
 * uninformative 400. The value itself is intentionally not pinned - a rollout of
 * a new supported version must be a coordinated code + config bump, and pinning
 * the accepted list here would defeat the whole point of putting the version in
 * the bundle.
 */
const apiVersionDate = filledIn.refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v), {
  message: "must be an ISO date (YYYY-MM-DD), matching GoHighLevel's version scheme",
});

/** Shape of the resolved secret bundle, after validation and coercion. */
export const secretBundleSchema = z.object({
  WL_API_HOST: bareHost,
  WL_AUTH_HOST: bareHost,
  WL_ID_REGION: positiveIntFromString,
  WL_K_BUSINESS: wlKey,
  WL_CLIENT_ID: opaqueSecret,
  WL_CLIENT_SECRET: opaqueSecret,
  SUPABASE_URL: httpsUrl,
  SUPABASE_SERVICE_ROLE_KEY: opaqueSecret,
  GHL_API_HOST: bareHost,
  GHL_API_VERSION: apiVersionDate,
  GHL_API_TOKEN: opaqueSecret,
  GHL_LOCATION_ID: filledIn,
});

export type ValidatedSecrets = z.output<typeof secretBundleSchema>;

/**
 * Non-secret runtime tuning, read straight from the process environment.
 * Defaults match the architecture doc section 8 (5 concurrent, ~5 req/s).
 */
export const runtimeOptionsSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  WL_MAX_CONCURRENCY: positiveIntFromString.default('5'),
  HTTP_TIMEOUT_MS: positiveIntFromString.default('30000'),
  // Off by default: on Vercel the filesystem is read-only apart from /tmp, and
  // /tmp does not survive the invocation. Deployed environments read the
  // platform log stream; file logs are for local runs and long-lived hosts.
  LOG_TO_FILE: booleanFromString,
  LOG_DIR: z.string().trim().min(1).default('logs'),
});

export const appEnvSchema = z.enum(APP_ENVS);

export interface WlConfig {
  /** Bare DATA host, e.g. the value of WL_API_HOST for this environment. */
  readonly host: string;
  /** `https://<host>` with no trailing slash. Data endpoints only. */
  readonly baseUrl: string;
  /** Bare AUTH host. WL serves /oauth2/token from a different host than data. */
  readonly authHost: string;
  /** `https://<authHost>` with no trailing slash. Token endpoint only. */
  readonly authBaseUrl: string;
  readonly idRegion: number;
  readonly kBusiness: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SupabaseConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export interface GhlConfig {
  /** Bare host, e.g. the value of GHL_API_HOST for this environment. */
  readonly host: string;
  /** `https://<host>` with no trailing slash. */
  readonly baseUrl: string;
  /**
   * Date-stamped API contract this build parses, sent as the `Version` header
   * on every call. Kept beside the host in the same bundle because the parsers
   * in this build are pinned to it: bumping this without a code change is a
   * silent shape drift, and pinning it without a config change would freeze the
   * whole fleet at whatever version was hardcoded.
   */
  readonly version: string;
  readonly apiToken: string;
  readonly locationId: string;
}

export interface RuntimeConfig {
  readonly logLevel: LogLevel;
  readonly maxConcurrency: number;
  readonly httpTimeoutMs: number;
  /** Whether to also append every line to files under `logDir`. */
  readonly logToFile: boolean;
  /** Directory for app.log and error.log. Relative paths resolve from cwd. */
  readonly logDir: string;
}

export interface AppConfig {
  readonly env: AppEnv;
  /** Which provider supplied the secrets, for health output and logs. */
  readonly secretsProviderName: string;
  readonly wl: WlConfig;
  readonly supabase: SupabaseConfig;
  readonly ghl: GhlConfig;
  readonly runtime: RuntimeConfig;
}

/** Thrown when resolved values are present but invalid. Never echoes a value. */
export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Formats zod issues as `KEY: message`.
 *
 * Built by hand rather than using zod's own formatter because that one can
 * include the received value, and these values are credentials.
 */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `${key}: ${issue.message}`;
  });
}
