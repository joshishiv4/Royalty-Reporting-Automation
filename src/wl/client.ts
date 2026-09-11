import type { WlConfig } from '../config/schema.js';
import type { AppEnv } from '../secrets/types.js';
import { buildWlUrl, type QueryValue } from './endpoint.js';
import {
  MAX_IN_PROCESS_RETRY_AFTER_MS,
  parseRetryAfter,
  retryDelayMs,
  throttleBackoffMs,
  THROTTLE_BACKOFF_MS,
} from './retry.js';
import { createTraceIds, readKLog, type TraceIdSource } from './trace.js';
import { WlAuthError, WlTokenClient, type WlTokenClientDeps } from './token.js';

/**
 * The authenticated WellnessLiving request path.
 *
 * Every data call goes through here, and every call does the same three things
 * in the same order: get a token (cached - see WlTokenClient), send the request
 * with business scoping, then assert on WL's own status field.
 *
 * THE RULE THAT DRIVES THIS MODULE: WL returns HTTP 200 for errors. A purchase
 * lookup with an empty key answers 200 OK with an `a_error[]` body and
 * `status: "id-empty"` (architecture doc section 2b). Success is
 * `status === "ok"` and nothing else. Without asserting that, a failed call is
 * handed to a mapper as if it were data and we silently write empty rows.
 *
 * Three further behaviours the architecture doc requires:
 *
 *   - `a_error[].sid` classifies the failure. Bad-parameter errors fail fast
 *     rather than burning retries; only genuinely transient ones are retried.
 *   - `k_log` is WL's trace id. It is captured on EVERY call, success or not,
 *     because a support ticket needs it and the call cannot be reproduced later.
 *   - A 401 means the token died early. The token is invalidated and the request
 *     is retried exactly once, immediately.
 */

export type WlFailureKind = 'auth' | 'transient' | 'permanent';

/** Everything a dead-letter record needs about a failed WL call (PRD M03). */
export interface WlErrorDetails {
  /** Path only - the host is configuration and must not reach a log. */
  readonly path: string;
  /** WL's machine-readable error code, from `a_error[].sid` or `status`. */
  readonly sid: string | null;
  /** Which field WL rejected, from `a_error[].s_field`. */
  readonly sField: string | null;
  /**
   * OUR trace id for this call. Always present.
   *
   * This is what ties a log line to a request. WL's own id is absent on most of
   * the endpoints this service uses, so an internal id is the only thing that
   * can be relied on - see src/wl/trace.ts.
   */
  readonly traceId: string;
  /**
   * WL's trace id, when they sent one. Null otherwise, and null is honest: a
   * fabricated id would send support looking for a log entry that never existed.
   */
  readonly kLog: string | null;
  readonly httpStatus: number | null;
  /**
   * How long the failing call took, in ms.
   *
   * Recorded on failures as well as successes: a timeout that took thirty
   * seconds and a rejection that took forty milliseconds are different problems,
   * and reporting either as 0 hides which one happened.
   */
  readonly latencyMs: number;
  /** WL's own `Retry-After`, in ms, when it sent one and it was sane. */
  readonly retryAfterMs: number | null;
  /** How many in-process attempts were made before giving up. Always >= 1. */
  readonly attempts: number;
  /**
   * How long the queue layer should wait before trying this item again, in ms,
   * or null when it is permanent or the schedule is exhausted (dead-letter).
   */
  readonly requeueAfterMs: number | null;
}

export class WlRequestError extends Error {
  constructor(
    readonly kind: WlFailureKind,
    message: string,
    readonly details: WlErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WlRequestError';
  }

  /** True when a backoff-and-retry could plausibly succeed. */
  get isRetryable(): boolean {
    return this.kind === 'transient';
  }
}

/** A successful WL response, plus the trace id that must be recorded with it. */
export interface WlResponse<T> {
  readonly body: T;
  /** OUR trace id for this call. Always present. */
  readonly traceId: string;
  /** WL's trace id, when they sent one. */
  readonly kLog: string | null;
  readonly httpStatus: number;
  readonly latencyMs: number;
}

export interface WlRequestOptions {
  /** Extra query parameters. `id_region` and `k_business` are added for you. */
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly method?: 'GET' | 'POST';
  /** Sent as a JSON body. Omit for GET. */
  readonly json?: unknown;
  /**
   * Absolute time (ms, on the client's own `now` clock) past which no NEW
   * attempt should be started. Derived from the pass budget by the caller so a
   * single slow-and-throttled item cannot retry past the window the platform
   * allows. Omit for an unbounded single call - health checks and tests. A call
   * already in flight is never abandoned; this only gates starting more work.
   */
  readonly deadline?: number;
  /**
   * How many times the queue layer (PRD M03) has ALREADY requeued this item,
   * 0-based. It selects the requeue rung on the 1 / 5 / 25 minute ladder for the
   * NEXT hand-back, so a repeatedly-failing item widens its spacing instead of
   * retrying every minute forever. When the ladder is spent (>= its length) the
   * item is dead-lettered - requeueAfterMs comes back null. Defaults to 0 (the
   * sync pass is always the first attempt); the worker passes the running count.
   * A WL `Retry-After` still outranks the ladder when WL sent one.
   */
  readonly priorAttempt?: number;
}

export interface WlClientDeps extends WlTokenClientDeps {
  /**
   * The token client to share.
   *
   * Pass ONE instance for the whole process so every worker reads the same
   * cache; a client that builds its own would multiply the auth calls by the
   * worker count, which is the thing the cache exists to prevent.
   */
  tokens?: WlTokenClient;
  /** Injectable delay so tests do not wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness so a test can pin the jitter. */
  random?: () => number;
  /**
   * Shared trace id source.
   *
   * Pass ONE per sync pass so every call carries the same run prefix and a
   * single grep pulls back the whole pass in order.
   */
  traces?: TraceIdSource;
  /** Fixed run id, e.g. to match a caller's own. Generated if omitted. */
  runId?: string;
}

export class WlClient {
  private readonly tokens: WlTokenClient;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly env: AppEnv | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly traces: TraceIdSource;

  constructor(
    private readonly wl: WlConfig,
    deps: WlClientDeps = {},
  ) {
    this.tokens = deps.tokens ?? new WlTokenClient(wl, deps);
    this.doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? 30_000;
    this.env = deps.env ?? null;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.traces =
      deps.traces ?? createTraceIds(deps.runId === undefined ? {} : { runId: deps.runId });
  }

  /** The run prefix every trace id from this client shares. */
  get runId(): string {
    return this.traces.runId;
  }

  /**
   * Fetches a token and nothing else, so a run fails before it starts.
   *
   * A scheduled sync should call this first: a bad credential discovered on
   * call one of three thousand is the same failure as a bad credential
   * discovered up front, but only one of them is legible in a cron log.
   * Throws WlAuthError, which names the environment.
   */
  async ensureAuthenticated(): Promise<void> {
    await this.tokens.getAccessToken();
  }

  /** The shared token cache, for health output and logs. */
  tokenStatus(): ReturnType<WlTokenClient['status']> {
    return this.tokens.status();
  }

  /**
   * Performs an authenticated WL call and returns the body only if WL said ok.
   *
   * @throws WlRequestError on any failure, HTTP or envelope.
   * @throws WlAuthError when no token could be obtained at all.
   */
  async request<T = unknown>(path: string, options: WlRequestOptions = {}): Promise<WlResponse<T>> {
    let authRetried = false;
    let throttleAttempt = 0;
    let attempts = 0;
    const deadline = options.deadline;
    const priorAttempt = options.priorAttempt ?? 0;
    // ONE id for the logical call, not one per attempt: retries are the same
    // operation, and `attempts` already records how many there were.
    const traceId = this.traces.next();

    for (;;) {
      attempts += 1;
      try {
        return await this.attempt<T>(path, options, traceId);
      } catch (error) {
        // A token could not be (re)fetched. WlAuthError is NOT a WlRequestError,
        // so without this it escapes unclassified and a step reports it as
        // "failed for an unknown reason" - discarding the one message that names
        // the environment and the credential to check. This is the normal path
        // after a mid-run 401: invalidate, refetch, and the refetch itself is
        // rejected because the credentials rotated under the run.
        if (error instanceof WlAuthError) {
          const backoff = throttleBackoffMs(throttleAttempt, this.random);
          if (
            error.kind === 'transient' &&
            backoff !== null &&
            this.canStartAfter(backoff, deadline)
          ) {
            throttleAttempt += 1;
            await this.sleep(backoff);
            continue;
          }
          throw this.authAsRequestError(error, path, traceId, attempts);
        }

        if (!(error instanceof WlRequestError)) throw error;

        // The token died early. One fresh token is worth exactly one more
        // attempt, immediately - this is not a backoff case.
        if (error.kind === 'auth' && !authRetried) {
          authRetried = true;
          this.tokens.invalidate();
          continue;
        }

        // PERMANENT: a bad parameter is just as bad in twenty-five minutes.
        // Fail now, with no retry and nothing for the queue to pick up.
        if (error.kind !== 'transient') {
          throw this.withRetryGuidance(error, attempts, null);
        }

        // TRANSIENT. Two delays can apply, and WL's own Retry-After outranks our
        // ladder when it sent one.
        const retryAfterMs = error.details.retryAfterMs;
        if (retryAfterMs !== null) {
          // Sleep it in-process only if it is short enough to fit a step AND the
          // next attempt would still start inside the budget. A longer wait is
          // requeued with EXACTLY that delay - honouring the server without
          // sleeping minutes inside a function the platform caps at 60s.
          if (
            retryAfterMs <= MAX_IN_PROCESS_RETRY_AFTER_MS &&
            throttleAttempt < THROTTLE_BACKOFF_MS.length &&
            this.canStartAfter(retryAfterMs, deadline)
          ) {
            throttleAttempt += 1;
            await this.sleep(retryAfterMs);
            continue;
          }
          throw this.withRetryGuidance(error, attempts, retryAfterMs);
        }

        // No Retry-After: our own in-process ladder, bounded by its length so a
        // persistent throttle cannot loop forever. When it is spent, or no time
        // is left, requeue on the rung the item's prior-attempt count selects -
        // a repeatedly-failing item widens its spacing rather than retrying every
        // minute. Null there means the ladder is exhausted: dead-letter.
        const backoff = throttleBackoffMs(throttleAttempt, this.random);
        if (backoff !== null && this.canStartAfter(backoff, deadline)) {
          throttleAttempt += 1;
          await this.sleep(backoff);
          continue;
        }

        throw this.withRetryGuidance(error, attempts, retryDelayMs(priorAttempt, this.random));
      }
    }
  }

  /**
   * Restamps a failure with what the caller needs to decide what happens next.
   *
   * Rebuilt rather than mutated because `details` is readonly, and a dead-letter
   * record that was quietly edited after the fact is worse than no record.
   */
  /**
   * Whether the next attempt would begin before the pass deadline.
   *
   * The deadline gates STARTING work, never a call already in flight - the same
   * rule batch.ts applies to items. No deadline means unbounded, which is the
   * right default for a health check or a one-off call.
   */
  private canStartAfter(backoffMs: number, deadline: number | undefined): boolean {
    return deadline === undefined || this.now() + backoffMs < deadline;
  }

  private withRetryGuidance(
    error: WlRequestError,
    attempts: number,
    requeueAfterMs: number | null,
  ): WlRequestError {
    return new WlRequestError(
      error.kind,
      error.message,
      { ...error.details, attempts, requeueAfterMs },
      error.cause === undefined ? undefined : { cause: error.cause },
    );
  }

  /**
   * Restates a token failure as a request failure, so a step reports the
   * credential message and this call's trace id instead of "unknown reason".
   *
   * WlAuthError already names the environment and the key to check, and that
   * text is host-safe by construction (see token.ts) - it is preserved verbatim,
   * because that message is the whole value of surfacing this rather than
   * swallowing it. A transient token failure that got here has spent the ladder,
   * so it is requeued; an auth/permanent one carries null and dead-letters.
   */
  private authAsRequestError(
    error: WlAuthError,
    path: string,
    traceId: string,
    attempts: number,
  ): WlRequestError {
    return new WlRequestError(
      error.kind,
      error.message,
      {
        path,
        traceId,
        sid: null,
        sField: null,
        kLog: null,
        httpStatus: error.httpStatus ?? null,
        retryAfterMs: null,
        attempts,
        requeueAfterMs: error.kind === 'transient' ? retryDelayMs(0, this.random) : null,
        latencyMs: 0,
      },
      { cause: error },
    );
  }

  private async attempt<T>(
    path: string,
    options: WlRequestOptions,
    traceId: string,
  ): Promise<WlResponse<T>> {
    // Token first, every time. The common path is a cache read; a refresh
    // happens here rather than mid-flight.
    const accessToken = await this.tokens.getAccessToken();

    const url = buildWlUrl(this.wl, path, options.query ?? {});
    const method = options.method ?? (options.json === undefined ? 'GET' : 'POST');
    const startedAt = this.now();

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(options.json === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new WlRequestError(
        'transient',
        `${method} ${path} did not complete${describeEnv(this.env)}: ${describeFetchFailure(cause, this.timeoutMs)}`,
        {
          path,
          traceId,
          sid: null,
          sField: null,
          kLog: null,
          httpStatus: null,
          retryAfterMs: null,
          attempts: 1,
          requeueAfterMs: null,
          // A timeout is the slowest failure there is; recording it as 0 would
          // throw away the one number that identifies it.
          latencyMs: this.now() - startedAt,
        },
        { cause },
      );
    }

    // WL's own instruction, when it sends one. Outranks any ladder we invented.
    // Read from headers, which cannot throw, before the body read that can.
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());

    // The body read is a second point the connection can fail - a reset or an
    // abort mid-stream throws HERE, after a clean connect. Left unguarded it
    // escapes as a raw Error with no kind, no trace id and no latency, and a
    // step reports it as "unknown reason": the one transient failure that gets
    // no classification. Guarded, it joins the ladder like any other.
    let raw: string;
    try {
      raw = await response.text();
    } catch (cause) {
      throw new WlRequestError(
        'transient',
        `${method} ${path} body was not received${describeEnv(this.env)}: ${describeFetchFailure(cause, this.timeoutMs)}`,
        {
          path,
          traceId,
          sid: null,
          sField: null,
          kLog: null,
          httpStatus: response.status,
          retryAfterMs,
          attempts: 1,
          requeueAfterMs: null,
          latencyMs: this.now() - startedAt,
        },
        { cause },
      );
    }
    const latencyMs = this.now() - startedAt;
    const body = parseJson(raw);
    const kLog = readKLog(body);

    if (!response.ok) {
      throw new WlRequestError(
        classifyHttpStatus(response.status),
        `${method} ${path} failed with HTTP ${String(response.status)}${describeEnv(this.env)}`,
        {
          path,
          traceId,
          sid: readStatus(body),
          sField: null,
          kLog,
          httpStatus: response.status,
          retryAfterMs,
          attempts: 1,
          requeueAfterMs: null,
          latencyMs,
        },
        undefined,
      );
    }

    // The HTTP 200 that is actually an error.
    const status = readStatus(body);
    if (status !== 'ok') {
      const first = readFirstError(body);
      const sid = first.sid ?? status;
      throw new WlRequestError(
        classifySid(sid),
        `${method} ${path} returned status "${sid ?? 'unknown'}"${describeEnv(this.env)}` +
          (first.message === null ? '' : `: ${first.message}`),
        {
          path,
          traceId,
          sid,
          sField: first.sField,
          kLog,
          httpStatus: response.status,
          retryAfterMs,
          attempts: 1,
          requeueAfterMs: null,
          latencyMs,
        },
        undefined,
      );
    }

    return { body: body as T, traceId, kLog, httpStatus: response.status, latencyMs };
  }
}

/** HTTP-level classification. Mirrors the token client's, minus the 400 case. */
function classifyHttpStatus(status: number): WlFailureKind {
  if (status === 401) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  return 'permanent';
}

/**
 * Patterns that mark a `sid` as worth retrying.
 *
 * Deliberately short. The architecture doc's rule for bad-parameter errors is
 * "fail fast, do not burn 3 retries", so anything unrecognised is PERMANENT.
 * WL has not published its sid vocabulary; extend this list as real transient
 * codes are observed in production rather than guessing at them now.
 */
const TRANSIENT_SID_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /throttl/i,
  /rate-?limit/i,
  /too-?many/i,
  /busy/i,
  /temporar/i,
  /try-?again/i,
  /unavailable/i,
];

/** Patterns that mean "the token is no good" rather than "the request is no good". */
const AUTH_SID_PATTERNS: readonly RegExp[] = [
  /token/i,
  /unauthor/i,
  /not-?authenticated/i,
  /expired/i,
  /signature/i,
];

function classifySid(sid: string | null): WlFailureKind {
  if (sid === null) return 'permanent';
  if (AUTH_SID_PATTERNS.some((p) => p.test(sid))) return 'auth';
  if (TRANSIENT_SID_PATTERNS.some((p) => p.test(sid))) return 'transient';
  return 'permanent';
}

function readStatus(body: unknown): string | null {
  return readString(body, 'status');
}

function readFirstError(body: unknown): {
  sid: string | null;
  sField: string | null;
  message: string | null;
} {
  const first = asRecord(readArray(body, 'a_error')[0]);
  if (first === null) {
    return { sid: null, sField: null, message: readString(body, 'message') };
  }
  return {
    sid: typeof first.sid === 'string' && first.sid.length > 0 ? first.sid : null,
    sField: typeof first.s_field === 'string' && first.s_field.length > 0 ? first.s_field : null,
    message:
      typeof first.s_message === 'string' && first.s_message.length > 0 ? first.s_message : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(body: unknown, key: string): string | null {
  const value = asRecord(body)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readArray(body: unknown, key: string): readonly unknown[] {
  const value = asRecord(body)?.[key];
  return Array.isArray(value) ? value : [];
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** ` for env "prod"`, or nothing when the caller did not say. */
function describeEnv(env: AppEnv | null): string {
  return env === null ? '' : ` for env "${env}"`;
}

function describeFetchFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return `timed out after ${String(timeoutMs)}ms`;
    }
    return cause.name;
  }
  return 'unknown error';
}

export { WlAuthError };
