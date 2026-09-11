import type { WlConfig } from '../config/schema.js';
import type { AppEnv } from '../secrets/types.js';
import { buildWlAuthUrl, WL_PATHS } from './endpoint.js';

/**
 * OAuth2 client-credentials token acquisition and caching for WellnessLiving.
 *
 * WL issues a Bearer JWT with a 3600-second life (architecture doc section 2b).
 * A token is therefore never a configuration value: it is fetched at runtime,
 * held in memory, and replaced before it expires. Nothing here is persisted -
 * a restart simply fetches a new one.
 *
 * Two behaviours matter for a long run:
 *
 *   1. PROACTIVE REFRESH. The cached token is treated as stale a few minutes
 *      before its stated expiry, so a call never leaves with a token that dies
 *      in flight. With WL's 3600s life and the default skew this refreshes at
 *      55 minutes (PRD M01).
 *
 *   2. SINGLE FLIGHT. A backfill runs many workers concurrently. Without
 *      de-duplication, every one of them would notice the stale token at the
 *      same moment and fire its own token request. Concurrent callers share one
 *      in-flight fetch instead.
 */

/** WL's documented token life, used only when a response omits expires_in. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/** How long before stated expiry a cached token is considered stale. */
const DEFAULT_REFRESH_SKEW_MS = 300_000;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Why a token request failed, so a caller can decide whether retrying is
 * pointless (`auth`, `permanent`) or worth a backoff (`transient`).
 */
export type WlAuthFailureKind = 'auth' | 'transient' | 'permanent';

export class WlAuthError extends Error {
  constructor(
    readonly kind: WlAuthFailureKind,
    message: string,
    readonly httpStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WlAuthError';
  }

  /** True when a backoff-and-retry could plausibly succeed. */
  get isRetryable(): boolean {
    return this.kind === 'transient';
  }
}

interface CachedToken {
  readonly accessToken: string;
  /** Epoch ms at which WL stops accepting this token. */
  readonly expiresAt: number;
  /** Epoch ms from which we proactively replace it. */
  readonly staleAt: number;
}

export interface WlTokenClientDeps {
  /**
   * Which environment these credentials belong to, named in failure messages.
   *
   * "credentials rejected" is not actionable on its own - dev and prod have
   * different pairs, so the first question is always which one was used.
   */
  env?: AppEnv;
  fetch?: typeof globalThis.fetch;
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
  timeoutMs?: number;
  refreshSkewMs?: number;
}

/** Safe-to-log view of the cache. Carries no token material. */
export interface WlTokenStatus {
  readonly cached: boolean;
  readonly expiresInMs: number | null;
  readonly fetchCount: number;
}

export class WlTokenClient {
  private cached: CachedToken | null = null;
  /** Shared by concurrent callers so only one token request is ever in flight. */
  private inFlight: Promise<CachedToken> | null = null;
  private fetchCount = 0;

  private readonly env: AppEnv | null;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly refreshSkewMs: number;

  constructor(
    private readonly wl: WlConfig,
    deps: WlTokenClientDeps = {},
  ) {
    // Bound to globalThis: an unbound reference to fetch throws "Illegal
    // invocation" in some runtimes.
    this.env = deps.env ?? null;
    this.doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.refreshSkewMs = deps.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  /**
   * Returns a token that is valid now, fetching or refreshing as needed.
   *
   * Safe to call on every request - the common path is a cache read.
   */
  async getAccessToken(): Promise<string> {
    const token = await this.getToken();
    return token.accessToken;
  }

  /**
   * Drops the cached token so the next call fetches a new one.
   *
   * Call this when WL rejects a token mid-run: a 401 on a data call means the
   * token died early (revoked, or credentials rotated under us), and the cached
   * copy is worthless regardless of its stated expiry.
   */
  invalidate(): void {
    this.cached = null;
  }

  /** Cache state for health output and logs. Never returns the token itself. */
  status(): WlTokenStatus {
    if (this.cached === null) {
      return { cached: false, expiresInMs: null, fetchCount: this.fetchCount };
    }
    return {
      cached: true,
      expiresInMs: this.cached.expiresAt - this.now(),
      fetchCount: this.fetchCount,
    };
  }

  private async getToken(): Promise<CachedToken> {
    const current = this.cached;
    if (current !== null && this.now() < current.staleAt) {
      return current;
    }

    // A refresh is already running - join it rather than starting a second.
    this.inFlight ??= this.fetchToken().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async fetchToken(): Promise<CachedToken> {
    const url = buildWlAuthUrl(this.wl, WL_PATHS.token);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.wl.clientId,
      client_secret: this.wl.clientSecret,
    });

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // Network failure and timeout are both worth retrying: neither says
      // anything about whether the credentials are good.
      throw new WlAuthError(
        'transient',
        `token request did not complete${describeEnv(this.env)}: ${describeFetchFailure(cause, this.timeoutMs)}`,
        undefined,
        { cause },
      );
    }

    const raw = await response.text();
    const payload = parseJson(raw);

    if (!response.ok) {
      throw new WlAuthError(
        classifyStatus(response.status),
        describeRejection(response.status, payload, this.env),
        response.status,
      );
    }

    const accessToken = readString(payload, 'access_token');
    if (accessToken === null) {
      // A 200 with no token is not retryable: the shape of the response
      // changed, and hammering it will not fix that.
      throw new WlAuthError(
        'permanent',
        `token endpoint returned HTTP 200 without an access_token${describeEnv(this.env)}`,
        response.status,
      );
    }

    const lifetimeMs = readLifetimeMs(payload);
    const issuedAt = this.now();
    // Never let the skew consume the whole life of a short-lived token, which
    // would make every single call refetch.
    const skewMs = Math.min(this.refreshSkewMs, Math.floor(lifetimeMs / 2));

    this.fetchCount += 1;
    const token: CachedToken = {
      accessToken,
      expiresAt: issuedAt + lifetimeMs,
      staleAt: issuedAt + lifetimeMs - skewMs,
    };
    this.cached = token;
    return token;
  }
}

/**
 * Maps an HTTP status to a retry decision.
 *
 * 400 and 401 are the OAuth spec's answers to bad credentials; 403 is WL's
 * answer to a client that exists but is not permitted. None improve on retry.
 */
function classifyStatus(status: number): WlAuthFailureKind {
  if (status === 400 || status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  return 'permanent';
}

/**
 * Builds a failure message from the status and the OAuth `error` code.
 *
 * The response body is deliberately NOT echoed: a token endpoint receives the
 * client secret, and an error body can quote back what it was sent.
 */
function describeRejection(status: number, payload: unknown, env: AppEnv | null): string {
  const code = readString(payload, 'error') ?? readString(payload, 'status');
  const suffix = code === null ? '' : ` (${code})`;
  const where = describeEnv(env);

  if (status === 400 || status === 401) {
    return `credentials rejected${where} with HTTP ${String(status)}${suffix} - check WL_CLIENT_ID and WL_CLIENT_SECRET for that environment`;
  }
  if (status === 403) {
    return `client is not permitted${where} with HTTP 403${suffix} - ask the WL Integrations team to confirm the credential's scope`;
  }
  if (status === 404) {
    return `token endpoint not found${where} (HTTP 404)${suffix} - WL_AUTH_HOST is probably pointing at the data host`;
  }
  return `token request failed${where} with HTTP ${String(status)}${suffix}`;
}

/** ` for env "prod"`, or nothing when the caller did not say. */
function describeEnv(env: AppEnv | null): string {
  return env === null ? '' : ` for env "${env}"`;
}

function readLifetimeMs(payload: unknown): number {
  const seconds = readNumber(payload, 'expires_in') ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  // A zero or negative life would cache a token that is already dead.
  const safeSeconds = seconds > 0 ? seconds : DEFAULT_TOKEN_LIFETIME_SECONDS;
  return safeSeconds * 1000;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // WL returns numbers as numbers here, but a string is cheap to accept.
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function describeFetchFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return `timed out after ${String(timeoutMs)}ms`;
    }
    // The message can carry the host, which is configuration - report only the
    // error class.
    return cause.name;
  }
  return 'unknown error';
}
