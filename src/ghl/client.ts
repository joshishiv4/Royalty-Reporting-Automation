import type { GhlConfig } from '../config/schema.js';
import type { AppEnv } from '../secrets/types.js';
import { buildGhlUrl, GHL_PATHS } from './endpoint.js';
import {
  MAX_IN_PROCESS_RETRY_AFTER_MS,
  parseRetryAfter,
  throttleBackoffMs,
  THROTTLE_BACKOFF_MS,
} from './retry.js';

/**
 * A small, read-only GoHighLevel client.
 *
 * THE ONE THING THIS CLIENT DOES is contact search. It has no create, update,
 * delete, upsert, patch, PUT or POST-that-writes surface anywhere. That is not
 * a code review promise; it is guaranteed by the shape of this class:
 *
 *   - The public API is exactly `searchContacts(...)`. There is no generic
 *     `request(...)` that a future caller could point at a mutating path.
 *   - `attempt()` is `private` and hardcodes method + path; a caller cannot
 *     talk it into POSTing to `/contacts/create`.
 *   - `GHL_PATHS` (see endpoint.ts) lists one path. Adding a write path there
 *     is a visible design change, not a one-line addition.
 *
 * `tests/ghl-client-read-only.test.ts` mechanically confirms this by scanning
 * the module for the shape of a create/update/delete method and for HTTP verbs
 * other than GET and POST-for-search. If someone bolts a write path on later
 * the build fails.
 *
 * WHY POST FOR A "SEARCH". GoHighLevel's contact search is a POST with a JSON
 * body of filters. That is how they document it and is unrelated to whether the
 * server side mutates anything - it does not. Read-only here is a property of
 * the SET OF PATHS this client will send to, not of the HTTP verb.
 *
 * WHY NO OAUTH DANCE. GHL Private Integration Tokens (PIT, `pit-...`) are
 * long-lived bearer tokens: no refresh flow to build, no token cache to share.
 * The token is sent verbatim on every request. If it is revoked the next call
 * fails with 401 and the run stops - which is the correct behaviour.
 *
 * SUCCESS IS THE HTTP STATUS. Unlike WellnessLiving, GHL uses HTTP status
 * honestly - 200 means ok, 4xx/5xx mean what they say. There is no "200 with
 * an error envelope inside" trap to guard against.
 */

export type GhlFailureKind = 'auth' | 'transient' | 'permanent';

/** Everything a caller needs about a failed GHL call. */
export interface GhlErrorDetails {
  /** Path only - the host is configuration and must not reach a log. */
  readonly path: string;
  readonly httpStatus: number | null;
  /**
   * How long the failing call took, in ms. Recorded on failures as well as
   * successes so a timeout and a rejection are told apart in a log.
   */
  readonly latencyMs: number;
  /** GHL's own `Retry-After`, in ms, when it sent one and it was sane. */
  readonly retryAfterMs: number | null;
  /** How many in-process attempts were made before giving up. Always >= 1. */
  readonly attempts: number;
}

export class GhlRequestError extends Error {
  constructor(
    readonly kind: GhlFailureKind,
    message: string,
    readonly details: GhlErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GhlRequestError';
  }

  /** True when a backoff-and-retry could plausibly succeed. */
  get isRetryable(): boolean {
    return this.kind === 'transient';
  }
}

/**
 * The filters the contact search accepts.
 *
 * Kept deliberately narrow. The matcher (PRD M08) looks contacts up by email
 * and by phone; nothing else is needed. Widening this later is a design change,
 * not an incidental one.
 */
export interface ContactSearchFilters {
  readonly email?: string;
  readonly phone?: string;
}

/** One contact as returned by GHL's search response. */
export interface GhlContact {
  readonly id: string;
  readonly locationId: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** Every other field the response carried, preserved for storage as raw_ghl. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface GhlSearchResponse {
  readonly contacts: readonly GhlContact[];
  readonly total: number;
  /** Milliseconds spent on the successful call. */
  readonly latencyMs: number;
  readonly httpStatus: number;
  /**
   * The whole response, exactly as GoHighLevel sent it, for raw_ghl (PRD M06).
   *
   * Kept separately from `contacts` because the typed view is lossy on purpose -
   * mapContact drops any contact with no id, and every field outside the six we
   * name survives only inside `raw`. A re-parse has to work from what arrived,
   * not from what we understood at the time.
   */
  readonly body: Readonly<Record<string, unknown>>;
  /**
   * GHL's own trace id, returned on EVERY response. Quote it on a support
   * ticket. Null only if a response somehow arrived without one.
   */
  readonly ghlTraceId: string | null;
  /** What was asked, so a stored payload can be read without guessing. */
  readonly requestParams: Readonly<Record<string, unknown>>;
}

export interface GhlClientDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  env?: AppEnv;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class GhlClient {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly env: AppEnv | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly ghl: GhlConfig,
    deps: GhlClientDeps = {},
  ) {
    this.doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? 30_000;
    this.env = deps.env ?? null;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
  }

  /**
   * Search contacts by email and/or phone within the configured location.
   *
   * At least one filter must be supplied - a search with no criteria is a bulk
   * enumeration the matcher never intends, and quietly returning "everyone"
   * would be a footgun.
   *
   * @throws GhlRequestError on any failure.
   */
  async searchContacts(filters: ContactSearchFilters): Promise<GhlSearchResponse> {
    if (filters.email === undefined && filters.phone === undefined) {
      throw new Error(
        'GhlClient.searchContacts requires at least one of { email, phone }: ' +
          'an unfiltered search is not what the matcher wants and would enumerate the location.',
      );
    }

    const body = buildSearchBody(this.ghl.locationId, filters);
    return this.#attempt(GHL_PATHS.contactsSearch, body);
  }

  /**
   * The one authenticated request path. Private on purpose: a caller cannot
   * reach it, so a caller cannot direct this client at a mutating endpoint.
   */
  // JavaScript #private, not TypeScript `private`: the latter is erased at
  // compile time and the method still sits on the prototype, so a caller can
  // reach it and the read-only shape test can see it. # is genuinely
  // unreachable, which is what "exposes no create or update capability" means.
  async #attempt(
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<GhlSearchResponse> {
    let throttleAttempt = 0;
    let attempts = 0;

    for (;;) {
      attempts += 1;
      const startedAt = this.now();

      let response: Response;
      try {
        response = await this.doFetch(buildGhlUrl(this.ghl, path), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.ghl.apiToken}`,
            Version: this.ghl.version,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        const latencyMs = this.now() - startedAt;
        const err = new GhlRequestError(
          'transient',
          `POST ${path} did not complete${describeEnv(this.env)}: ${describeFetchFailure(cause, this.timeoutMs)}`,
          { path, httpStatus: null, latencyMs, retryAfterMs: null, attempts },
          { cause },
        );
        if (this.#shouldBackOff(throttleAttempt)) {
          const backoff = throttleBackoffMs(throttleAttempt, this.random) ?? 0;
          throttleAttempt += 1;
          await this.sleep(backoff);
          continue;
        }
        throw err;
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());

      let raw: string;
      try {
        raw = await response.text();
      } catch (cause) {
        const latencyMs = this.now() - startedAt;
        throw new GhlRequestError(
          'transient',
          `POST ${path} body was not received${describeEnv(this.env)}: ${describeFetchFailure(cause, this.timeoutMs)}`,
          {
            path,
            httpStatus: response.status,
            latencyMs,
            retryAfterMs,
            attempts,
          },
          { cause },
        );
      }
      const latencyMs = this.now() - startedAt;

      if (response.ok) {
        return parseSearchResponse(raw, response.status, latencyMs, path, body);
      }

      const kind = classifyHttpStatus(response.status);
      const failure = new GhlRequestError(
        kind,
        `POST ${path} failed with HTTP ${String(response.status)}${describeEnv(this.env)}`,
        { path, httpStatus: response.status, latencyMs, retryAfterMs, attempts },
      );

      if (kind !== 'transient') throw failure;

      // TRANSIENT. GHL's own Retry-After outranks our ladder when it sent one
      // and it fits inside the step.
      if (retryAfterMs !== null) {
        if (
          retryAfterMs <= MAX_IN_PROCESS_RETRY_AFTER_MS &&
          throttleAttempt < THROTTLE_BACKOFF_MS.length
        ) {
          throttleAttempt += 1;
          await this.sleep(retryAfterMs);
          continue;
        }
        throw failure;
      }

      if (this.#shouldBackOff(throttleAttempt)) {
        const backoff = throttleBackoffMs(throttleAttempt, this.random) ?? 0;
        throttleAttempt += 1;
        await this.sleep(backoff);
        continue;
      }
      throw failure;
    }
  }

  #shouldBackOff(throttleAttempt: number): boolean {
    return throttleAttempt < THROTTLE_BACKOFF_MS.length;
  }
}

/**
 * GHL's search body is NOT a flat set of fields. Probed live 26 Aug 2026, the
 * obvious shape - {locationId, email} - is rejected 422 with a message that says
 * exactly what is wrong:
 *
 *   "property email should not exist"
 *   "pageLimit must be a number conforming to the specified constraints"
 *
 * So a term goes in a `filters` array as {field, operator, value}, and pageLimit
 * is REQUIRED - omitting it fails even when there is nothing to filter on. Both
 * were confirmed by calling the live endpoint, not inferred.
 */
const SEARCH_PAGE_LIMIT = 20;

function buildSearchBody(
  locationId: string,
  filters: ContactSearchFilters,
): Readonly<Record<string, unknown>> {
  const terms: Array<Record<string, unknown>> = [];
  if (filters.email !== undefined) {
    terms.push({ field: 'email', operator: 'eq', value: filters.email });
  }
  if (filters.phone !== undefined) {
    terms.push({ field: 'phone', operator: 'eq', value: filters.phone });
  }

  // terms is never empty: searchContacts refuses a call with neither email nor
  // phone before it reaches here, because an unfiltered search would enumerate
  // the whole location.
  return { locationId, pageLimit: SEARCH_PAGE_LIMIT, filters: terms };
}

function parseSearchResponse(
  raw: string,
  httpStatus: number,
  latencyMs: number,
  path: string,
  requestParams: Readonly<Record<string, unknown>>,
): GhlSearchResponse {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (cause) {
    throw new GhlRequestError(
      'transient',
      `POST ${path} returned a body that is not JSON`,
      { path, httpStatus, latencyMs, retryAfterMs: null, attempts: 1 },
      { cause },
    );
  }

  const record = asRecord(body);
  const contactsRaw = record === null ? null : record.contacts;
  const contacts = Array.isArray(contactsRaw)
    ? contactsRaw.map(mapContact).filter((c): c is GhlContact => c !== null)
    : [];
  const total =
    record !== null && typeof record.total === 'number' ? record.total : contacts.length;

  return {
    contacts,
    total,
    latencyMs,
    httpStatus,
    body: record ?? {},
    ghlTraceId: record !== null && typeof record.traceId === 'string' ? record.traceId : null,
    requestParams,
  };
}

function mapContact(value: unknown): GhlContact | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = typeof record.id === 'string' ? record.id : null;
  if (id === null) return null;
  return {
    id,
    locationId: typeof record.locationId === 'string' ? record.locationId : '',
    email: typeof record.email === 'string' ? record.email : null,
    phone: typeof record.phone === 'string' ? record.phone : null,
    firstName: typeof record.firstName === 'string' ? record.firstName : null,
    lastName: typeof record.lastName === 'string' ? record.lastName : null,
    raw: record,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function classifyHttpStatus(status: number): GhlFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  return 'permanent';
}

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
