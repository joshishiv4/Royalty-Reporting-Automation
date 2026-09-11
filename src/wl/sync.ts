import type { AppConfig } from '../config/schema.js';
import type { AppEnv } from '../secrets/types.js';
import { runBatch } from './batch.js';
import { WlClient, WlRequestError, type WlClientDeps } from './client.js';
import { WL_PATHS } from './endpoint.js';
import { WlAuthError } from './token.js';

/**
 * One authenticated WellnessLiving sync pass.
 *
 * The shape this enforces is the one that matters: AUTHENTICATE FIRST, then run
 * every operation on the shared token. A credential problem therefore surfaces
 * before any work is attempted, which is the difference between a cron log that
 * says "auth failed for env prod" and one that says "call 1 of 3000 failed".
 *
 * SCOPE, honestly stated: this reads. It does not yet write to Supabase, because
 * the schema (PRD M02) and the queue/worker layer (M03) do not exist yet. What
 * it does prove, in the deployed environment rather than on a laptop, is that
 * the whole chain works: token acquisition, business scoping, the
 * `status === "ok"` assertion and `k_log` capture. When the sync engine lands,
 * the steps below are replaced by real work and this function keeps its shape.
 *
 * TIME BUDGET: a Vercel function is capped (60s on Hobby) while the full daily
 * sync is budgeted at two hours (PRD section 12). So this stops STARTING new
 * steps once the budget is spent and reports what it skipped. It never truncates
 * silently - a summary that looks complete when it is not is worse than a
 * summary that says it ran out of time.
 */

/** Default step budget, comfortably inside the platform's 60s function cap. */
const DEFAULT_BUDGET_MS = 50_000;

/** The read-only calls a pass makes today, in order. */
const STEPS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'business', path: WL_PATHS.business },
  { name: 'locations', path: WL_PATHS.locationList },
  { name: 'staff', path: WL_PATHS.staffList },
];

export interface WellnessSyncStep {
  readonly name: string;
  readonly path: string;
  readonly ok: boolean;
  /** Safe to log: never contains business data, a host or a credential. */
  readonly detail: string;
  /** OUR trace id for this call. Always present, so a log line is traceable. */
  readonly traceId: string;
  /** WL's trace id. Null when WL did not send one - it does not on every endpoint. */
  readonly kLog: string | null;
  readonly latencyMs: number;
  /**
   * How many records each top-level collection held, by field name. Counts only.
   *
   * WL returns list endpoints as KEYED OBJECTS, not arrays - `a_staff` is an
   * object keyed by uid, `a_location` by location key (verified live, 19 Aug
   * 2026). So an object's key count is as much a row count as an array's length,
   * and any mapper must iterate with Object.values() rather than treating these
   * as arrays.
   */
  readonly collections?: Readonly<Record<string, number>>;
  readonly sid?: string | null;
  readonly kind?: string;
  readonly httpStatus?: number | null;
}

export interface WellnessSyncSummary {
  readonly env: AppEnv;
  readonly ok: boolean;
  /** How many times a token was actually fetched. Should be 1 for a short pass. */
  readonly tokenFetches: number;
  readonly durationMs: number;
  readonly steps: readonly WellnessSyncStep[];
  /** Steps not attempted because the time budget ran out. Never silent. */
  readonly skipped: readonly string[];
  /** The run prefix every trace id in this pass shares. Grep this to see it all. */
  readonly runId: string;
  /** Present only when authentication itself failed, so no step ran. */
  readonly authError?: string;
}

export interface WellnessSyncDeps extends WlClientDeps {
  /** Stop starting new steps after this many ms. */
  budgetMs?: number;
  /** Inject a pre-built client, e.g. to share one token cache across passes. */
  client?: WlClient;
  /** How many steps to run in flight. Defaults to WL_MAX_CONCURRENCY. */
  concurrency?: number;
}

export async function runWellnessSync(
  config: AppConfig,
  deps: WellnessSyncDeps = {},
): Promise<WellnessSyncSummary> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = now();

  const client =
    deps.client ??
    new WlClient(config.wl, {
      ...deps,
      env: config.env,
      timeoutMs: deps.timeoutMs ?? config.runtime.httpTimeoutMs,
      now,
    });

  // Authenticate before anything else. A failure here ends the pass with a
  // message that names the environment, and no step is attempted.
  try {
    await client.ensureAuthenticated();
  } catch (error) {
    return {
      env: config.env,
      ok: false,
      tokenFetches: client.tokenStatus().fetchCount,
      durationMs: now() - startedAt,
      steps: [],
      skipped: STEPS.map((s) => s.name),
      runId: client.runId,
      authError:
        error instanceof WlAuthError
          ? error.message
          : 'authentication failed for an unknown reason',
    };
  }

  // Batched rather than a sequential loop: the steps are independent, so one
  // slow endpoint should not hold up the others. runBatch also owns the budget
  // check, and reports what it never started instead of truncating silently.
  // The same budget the batch uses to gate STARTING items, expressed as an
  // absolute deadline so one already-started item cannot retry past it either.
  // No new number: startedAt + budgetMs is the window the batch already honours.
  const deadline = startedAt + budgetMs;
  const batch = await runBatch(STEPS, (step) => runStep(client, step, deadline), {
    // Bounds how many items are in flight, NOT a request rate: WL publishes no
    // rate limit and this service no longer invents one.
    concurrency: deps.concurrency ?? config.runtime.maxConcurrency,
    budgetMs,
    now,
    startedAt,
  });

  // runStep never throws - it turns a WlRequestError into a failed step - so a
  // failure here is a bug rather than an API problem. Recorded, not swallowed.
  const steps: WellnessSyncStep[] = [
    ...batch.results,
    ...batch.failures.map((f) => unexpectedStepFailure(f.item, f.error)),
  ];
  const skipped = batch.remaining.map((step) => step.name);

  return {
    env: config.env,
    ok: steps.every((s) => s.ok) && skipped.length === 0,
    tokenFetches: client.tokenStatus().fetchCount,
    durationMs: now() - startedAt,
    steps,
    skipped,
    runId: client.runId,
  };
}

/**
 * A step that threw where it should have returned. Should never happen -
 * runStep turns a WlRequestError into a failed step rather than throwing - so
 * reaching here is a bug, and the error is the only clue to it. The class name
 * is recorded (host-safe, unlike the message) rather than discarded.
 */
function unexpectedStepFailure(
  step: { name: string; path: string },
  error: unknown,
): WellnessSyncStep {
  return {
    name: step.name,
    path: step.path,
    ok: false,
    detail: `failed unexpectedly: ${error instanceof Error ? error.name : 'unknown error'}`,
    traceId: 'unknown',
    kLog: null,
    latencyMs: 0,
  };
}

async function runStep(
  client: WlClient,
  step: { name: string; path: string },
  deadline: number,
): Promise<WellnessSyncStep> {
  try {
    const response = await client.request<Record<string, unknown>>(step.path, { deadline });
    return {
      name: step.name,
      path: step.path,
      ok: true,
      detail: 'ok',
      traceId: response.traceId,
      kLog: response.kLog,
      latencyMs: response.latencyMs,
      collections: countCollections(response.body),
      httpStatus: response.httpStatus,
    };
  } catch (error) {
    if (error instanceof WlRequestError) {
      return {
        name: step.name,
        path: step.path,
        ok: false,
        detail: error.message,
        traceId: error.details.traceId,
        kLog: error.details.kLog,
        // The real duration, not 0: a 30s timeout and a 40ms rejection are
        // different problems and the log has to tell them apart.
        latencyMs: error.details.latencyMs,
        sid: error.details.sid,
        kind: error.kind,
        httpStatus: error.details.httpStatus,
      };
    }
    return {
      name: step.name,
      path: step.path,
      ok: false,
      detail: 'failed for an unknown reason',
      traceId: 'unknown',
      kLog: null,
      latencyMs: 0,
    };
  }
}

/**
 * Size of every top-level collection in the payload, by field name.
 *
 * Counts only - no values. Arrays report their length, objects their key count,
 * because WL uses keyed objects for list endpoints. Enough to see that an
 * endpoint returned rows and how many, without asserting anything about field
 * names that the field mapping has not yet confirmed.
 */
function countCollections(body: unknown): Record<string, number> {
  if (typeof body !== 'object' || body === null) return {};
  const counts: Record<string, number> = {};
  // Cast to a known record so each value is `unknown` rather than `any`.
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      counts[key] = value.length;
    } else if (typeof value === 'object' && value !== null) {
      counts[key] = Object.keys(value).length;
    }
  }
  return counts;
}
