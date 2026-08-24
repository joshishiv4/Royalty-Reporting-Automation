import type { AppConfig } from '../config/schema.js';
import { SupabaseClient } from '../supabase/client.js';
import { WlClient, WlRequestError } from '../wl/client.js';
import { WL_PATHS } from '../wl/endpoint.js';
import { WlTokenClient } from '../wl/token.js';
import { closeJobState, openJobState } from './job-state.js';
import { writeLocationList } from './locations.js';
import { writeMembership } from './memberships.js';
import { writePromotionList } from './promotions.js';
import { writePurchaseList } from './purchases.js';
import { enqueue, outcomeFromWlError, type QueueHandler, runQueue } from './queue.js';
import { writeProfile } from './profiles.js';
import { writeRecipient } from './recipients.js';
import { writeReceipt } from './receipts.js';
import { writeServiceCategoryList, writeServiceList } from './services.js';
import { writeShopCategoryList } from './shop-categories.js';
import { writeStaffList } from './writer.js';

/**
 * One bounded sync pass, the shape the cron route runs.
 *
 * A pass opens a `sync_run` row, seeds and drains the queue within a time budget,
 * and closes the row with an honest verdict. `partial` - the budget ran out with
 * work still eligible - is the NORMAL way a long run ends, not a failure: the next
 * invocation resumes from the queue, because the queue is the durable cursor.
 *
 * NOT here yet: the `sync_job_state` page cursor. It only matters for a paginated
 * fetch, and the jobs so far are single calls (a staff list, a per-uid purchase
 * list). It lands with paginated work; until then the queue resumes BETWEEN calls.
 */

export interface SyncPassDeps {
  /** Share one WL client per pass so every call carries the same run id. */
  wl?: WlClient;
  db?: SupabaseClient;
  now?: () => number;
  /** Stop STARTING new queue batches once this many ms have passed. */
  budgetMs?: number;
  /** Items claimed per batch. */
  limit?: number;
  /** Claim lease length, kept above the step budget. */
  leaseMs?: number;
}

export interface SyncPassSummary {
  readonly runId: string;
  readonly state: 'ok' | 'partial' | 'failed';
  readonly claimed: number;
  readonly done: number;
  readonly requeued: number;
  readonly dead: number;
  readonly itemsRemaining: number;
  readonly error?: string;
}

const DEFAULT_BUDGET_MS = 50_000;
const DEFAULT_LIMIT = 10;
const DEFAULT_LEASE_MS = 55_000;

/** What the passes share; only the job name, work type, seeding and handler differ. */
interface PassContext {
  readonly wl: WlClient;
  readonly db: SupabaseClient;
  readonly kBusiness: string;
  readonly runId: string;
  /** The pass clock as an ISO string - the same clock the claim filters on. */
  readonly nowIso: () => string;
}

interface JobSpec {
  readonly jobName: string;
  /** The queue work_type this pass owns; it claims only these items. */
  readonly workType: string;
  /** Enqueues the work this pass should drain. */
  readonly seed: (ctx: PassContext) => Promise<void>;
  /** Builds the handler that processes one claimed item. */
  readonly makeHandler: (ctx: PassContext) => QueueHandler;
}

/** Runs the staff sync: one job that lists staff and writes them as people. */
export function runStaffSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'staff_sync',
    workType: 'staff_list',
    seed: ({ db, kBusiness, nowIso }) =>
      enqueue(
        db,
        [{ work_type: 'staff_list', target_key: 'all', k_business: kBusiness }],
        nowIso(),
      ).then(() => undefined),
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.staffList, {
            priorAttempt: item.attempt_count,
          });
          await writeStaffList(db, { kBusiness, response, runId });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the location sync: one job that lists locations and enriches their detail
 * (title, timezone) over the stubs the purchase writer left. One WL call.
 */
export function runLocationSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'location_sync',
    workType: 'location_list',
    seed: ({ db, kBusiness, nowIso }) =>
      enqueue(
        db,
        [{ work_type: 'location_list', target_key: 'all', k_business: kBusiness }],
        nowIso(),
      ).then(() => undefined),
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.locationList, {
            priorAttempt: item.attempt_count,
          });
          await writeLocationList(db, { kBusiness, response, runId });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the purchase sync: one job PER person, each listing that uid's purchases.
 *
 * Seeded from `person.uid`, so coverage is exactly the people already synced
 * (staff today). The uid is the payer and already a person row, so the FK holds;
 * completeness grows as `person` does. Money is not here - it needs the receipt
 * (task 015).
 */
export function runPurchaseSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'purchase_sync',
    workType: 'purchase_list',
    seed: async ({ db, kBusiness, nowIso }) => {
      const people = await db.select<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&select=uid`,
      );
      await enqueue(
        db,
        people.map((p) => ({
          work_type: 'purchase_list',
          target_key: p.uid,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.profilePurchaseList, {
            query: { uid: item.target_key },
            priorAttempt: item.attempt_count,
          });
          await writePurchaseList(db, {
            kBusiness,
            uidPayer: item.target_key,
            response,
            runId,
          });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the receipt sync: one job PER purchase still missing its total, each
 * fetching /v1/purchase/receipt to fill money and the payment breakdown (task 015).
 * Seeded from purchases with a null m_total, so a re-run enriches only the unpriced.
 */
export function runReceiptSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'receipt_sync',
    workType: 'purchase_receipt',
    seed: async ({ db, kBusiness, nowIso }) => {
      const unpriced = await db.select<{ k_purchase: string }>(
        'purchase',
        `k_business=eq.${kBusiness}&m_total=is.null&select=k_purchase`,
      );
      await enqueue(
        db,
        unpriced.map((p) => ({
          work_type: 'purchase_receipt',
          target_key: p.k_purchase,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.purchaseReceipt, {
            query: { k_purchase: item.target_key },
            priorAttempt: item.attempt_count,
          });
          await writeReceipt(db, { kBusiness, kPurchase: item.target_key, response, runId });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the purchase-element sync: one job PER purchase item, each fetching
 * /v1/profile/purchase/list/element and taking TWO things from the one payload -
 * the recipient (task 021) and the membership/refund detail (PRD 6.2, task 023).
 *
 * Payer lands with the purchase list; the recipient (a parent buys for a child)
 * only exists on the element endpoint. Disagreement between two items of one
 * purchase parks a sync_conflict (see recipients.ts).
 *
 * SEEDS EVERY ITEM, not just unattributed ones. Until 6.2 this pass seeded only
 * items whose purchase had a null uid_recipient, because a recipient never
 * changes. Membership state does - a hold starts, a cancellation goes pending, a
 * renewal counter ticks - so the detail needs refresh semantics or it is captured
 * once and silently rots. Re-fetching an attributed item is safe: the recipient
 * write is fill-only and treats an agreeing item as a no-op.
 *
 * ONE PAYLOAD, ONE RAW ROW. writeRecipient stores it and returns the raw_wl id;
 * writeMembership is handed that id rather than storing the same body twice.
 */
export function runPurchaseElementSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'purchase_element_sync',
    workType: 'purchase_item_element',
    seed: async ({ db, kBusiness, nowIso }) => {
      const items = await db.select<{ k_purchase_item: string }>(
        'purchase_item',
        `k_business=eq.${kBusiness}&select=k_purchase_item`,
      );
      await enqueue(
        db,
        items.map((i) => ({
          work_type: 'purchase_item_element',
          target_key: i.k_purchase_item,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.profilePurchaseListElement, {
            query: { k_purchase_item: item.target_key },
            priorAttempt: item.attempt_count,
          });
          const { rawWlId } = await writeRecipient(db, {
            kBusiness,
            kPurchaseItem: item.target_key,
            response,
            runId,
          });
          // Same payload, second typed write - see the header.
          await writeMembership(db, {
            kBusiness,
            kPurchaseItem: item.target_key,
            response,
            rawWlId,
          });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the profile sync: one job PER person, each fetching /v1/user to merge the
 * client's contact detail - crucially the PRIMARY email - onto their person row
 * (PRD 6.1). /v1/user is the only place the primary email appears, so this is the
 * enrichment GoHighLevel matching waits for.
 *
 * Seeded from `person.uid`, so coverage is exactly the people already synced. That
 * is bounded today by who we can enumerate (staff, plus purchase payers/recipients)
 * - the wider client base needs the client-list unblock (STATUS blocker 1). The
 * pull, merge, park-on-failure and idempotent re-run all work now over whatever
 * person rows exist. A failed profile call parks in the queue (dead-letter) without
 * stopping the others, like every pass. Merge never clobbers (see profiles.ts).
 */
export function runProfileSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'profile_sync',
    workType: 'user_profile',
    seed: async ({ db, kBusiness, nowIso }) => {
      const people = await db.select<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&select=uid`,
      );
      await enqueue(
        db,
        people.map((p) => ({
          work_type: 'user_profile',
          target_key: p.uid,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.user, {
            query: { uid: item.target_key },
            priorAttempt: item.attempt_count,
          });
          await writeProfile(db, { kBusiness, uid: item.target_key, response, runId });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the shop-category sync: one job that lists storefront categories.
 *
 * Genuinely business-wide - the endpoint answers with no k_location - so it is
 * seeded as a single 'all' item, like staff and locations. Upsert on
 * k_shop_category means a re-run produces no duplicates.
 */
export function runShopCategorySyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'shop_category_sync',
    workType: 'shop_category_list',
    seed: ({ db, kBusiness, nowIso }) =>
      enqueue(
        db,
        [{ work_type: 'shop_category_list', target_key: 'all', k_business: kBusiness }],
        nowIso(),
      ).then(() => undefined),
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.shopCategory, {
            priorAttempt: item.attempt_count,
          });
          await writeShopCategoryList(db, { kBusiness, response, runId });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the promotion sync: one job PER location, each listing that location's
 * promotions.
 *
 * Promotions are per-location (the endpoint needs a k_location), so this seeds
 * from the `location` table - coverage is exactly the locations already synced.
 * A k_promotion is unique across the business, so the same promotion under a
 * second location updates in place; upsert on k_promotion means neither a second
 * location nor a re-run duplicates it.
 */
export function runPromotionSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'promotion_sync',
    workType: 'promotion_list',
    seed: async ({ db, kBusiness, nowIso }) => {
      const locations = await db.select<{ k_location: string }>(
        'location',
        `k_business=eq.${kBusiness}&select=k_location`,
      );
      await enqueue(
        db,
        locations.map((l) => ({
          work_type: 'promotion_list',
          target_key: l.k_location,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.classesPromotion, {
            query: { k_location: item.target_key },
            priorAttempt: item.attempt_count,
          });
          await writePromotionList(db, {
            kBusiness,
            kLocation: item.target_key,
            response,
            runId,
          });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the service-category sync: one job PER location, each listing that
 * location's bookable-service categories.
 *
 * Per-location (the endpoint needs a k_location), so this seeds from the
 * `location` table - coverage is exactly the locations already synced. A
 * k_service_category is unique business-wide, so upsert on it dedupes a category
 * that repeats across locations, and a re-run changes nothing new.
 */
export function runServiceCategorySyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'service_category_sync',
    workType: 'service_category_list',
    seed: async ({ db, kBusiness, nowIso }) => {
      const locations = await db.select<{ k_location: string }>(
        'location',
        `k_business=eq.${kBusiness}&select=k_location`,
      );
      await enqueue(
        db,
        locations.map((l) => ({
          work_type: 'service_category_list',
          target_key: l.k_location,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.appointmentServiceCategory, {
            query: { k_location: item.target_key },
            priorAttempt: item.attempt_count,
          });
          await writeServiceCategoryList(db, {
            kBusiness,
            kLocation: item.target_key,
            response,
            runId,
          });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the service-catalogue sync: one job PER location, each listing that
 * location's bookable services and marking them resolved.
 *
 * Per-location and seeded from the `location` table, like the category pass. A
 * k_service is unique business-wide, so upsert on it enriches the FK stub the
 * purchase writer left (flipping is_resolved to true) and dedupes across
 * locations. Runs AFTER purchases in a full pass so the authoritative catalogue
 * title wins for resolved services, while services only ever seen in a purchase
 * keep their derived title and stay unresolved (a countable gap - see 0012).
 */
export function runServiceSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'service_sync',
    workType: 'service_list',
    seed: async ({ db, kBusiness, nowIso }) => {
      const locations = await db.select<{ k_location: string }>(
        'location',
        `k_business=eq.${kBusiness}&select=k_location`,
      );
      await enqueue(
        db,
        locations.map((l) => ({
          work_type: 'service_list',
          target_key: l.k_location,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.appointmentServiceList, {
            query: { k_location: item.target_key },
            priorAttempt: item.attempt_count,
          });
          await writeServiceList(db, {
            kBusiness,
            kLocation: item.target_key,
            response,
            runId,
          });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * One entry for each pass a full sync runs, in the order it ran.
 *
 * `ran: false` means the global budget was spent before this pass started - its
 * work was never seeded, and the next invocation resumes from here. It is NOT a
 * failure: the earlier passes drain fast on a later call (their queues already
 * empty), so the budget flows down the list over repeated crons.
 */
export interface FullSyncPassResult {
  readonly job: string;
  readonly ran: boolean;
  readonly summary: SyncPassSummary | null;
}

export interface FullSyncSummary {
  readonly runId: string;
  readonly state: 'ok' | 'partial' | 'failed';
  readonly durationMs: number;
  readonly passes: readonly FullSyncPassResult[];
}

/** The order the passes run in, respecting the FK dependencies between them. */
const FULL_SYNC_ORDER: ReadonlyArray<{
  readonly job: string;
  readonly run: (config: AppConfig, deps: SyncPassDeps) => Promise<SyncPassSummary>;
}> = [
  // person rows first: purchases are seeded from person.uid.
  { job: 'staff_sync', run: runStaffSyncPass },
  // location rows next: promotions and the service catalogue seed from locations.
  { job: 'location_sync', run: runLocationSyncPass },
  // business-wide reference, no dependency.
  { job: 'shop_category_sync', run: runShopCategorySyncPass },
  // per-location: needs the location rows above.
  { job: 'promotion_sync', run: runPromotionSyncPass },
  // per-location: bookable-service categories.
  { job: 'service_category_sync', run: runServiceCategorySyncPass },
  // per-person: needs the person rows above.
  { job: 'purchase_sync', run: runPurchaseSyncPass },
  // per-purchase money: needs the purchase rows above.
  { job: 'receipt_sync', run: runReceiptSyncPass },
  // per-item recipient + membership detail: needs the purchase_item rows above.
  { job: 'purchase_element_sync', run: runPurchaseElementSyncPass },
  // per-person profile enrichment (primary email for GHL): after every pass that
  // creates a person row, so it enriches payers and recipients too, not just staff.
  { job: 'profile_sync', run: runProfileSyncPass },
  // per-location catalogue LAST: it upserts the authoritative title over any
  // purchase-derived stub and marks resolved services, so it must run after the
  // purchase pass that creates those stubs.
  { job: 'service_sync', run: runServiceSyncPass },
];

const DEFAULT_FULL_BUDGET_MS = 50_000;
/** Below this, a pass would only seed and immediately stop; skip it instead. */
const MIN_PASS_BUDGET_MS = 3_000;

/**
 * Runs every sync pass in dependency order within ONE global time budget, the
 * shape the daily cron calls for a full WL -> Supabase pull.
 *
 * ONE token, ONE database. A shared WlTokenClient means the whole run
 * authenticates once (the first request fetches it, the rest read the cache);
 * each pass still gets its OWN WlClient so its `runId` is distinct and its
 * `sync_run` row does not collide with another pass's.
 *
 * BOUNDED, like a single pass. A Vercel function is capped at 60s while a full
 * sync is budgeted in hours, so the global budget is split across the passes:
 * each gets whatever time is left, and once it is spent the remaining passes are
 * reported `ran: false` and picked up by the next invocation. The queue is the
 * durable cursor; the cron calling this repeatedly is what drains it.
 */
export async function runFullSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<FullSyncSummary> {
  const now = deps.now ?? (() => Date.now());
  const totalBudgetMs = deps.budgetMs ?? DEFAULT_FULL_BUDGET_MS;
  const startedAt = now();

  // One database and one token client for the whole run. The token client is
  // shared so authentication happens once; the DB client carries no per-run
  // state, so sharing it just avoids rebuilding it six times.
  const db = deps.db ?? new SupabaseClient(config.supabase);
  const tokens = new WlTokenClient(config.wl, { env: config.env });

  const passes: FullSyncPassResult[] = [];
  for (const { job, run } of FULL_SYNC_ORDER) {
    const remaining = totalBudgetMs - (now() - startedAt);
    if (remaining < MIN_PASS_BUDGET_MS) {
      passes.push({ job, ran: false, summary: null });
      continue;
    }
    // A fresh WlClient per pass: distinct runId (no sync_run collision), shared
    // token cache (one auth for the whole run). An injected client (tests) is
    // reused across passes instead - there is no real sync_run constraint to
    // collide with behind a fake db.
    const wl =
      deps.wl ??
      new WlClient(config.wl, {
        tokens,
        env: config.env,
        timeoutMs: config.runtime.httpTimeoutMs,
        now,
      });
    const summary = await run(config, { ...deps, wl, db, budgetMs: remaining, now });
    passes.push({ job, ran: true, summary });
  }

  const ran = passes.filter((p) => p.summary !== null).map((p) => p.summary as SyncPassSummary);
  const anyFailed = ran.some((s) => s.state === 'failed');
  const anyIncomplete =
    passes.some((p) => !p.ran) || ran.some((s) => s.state === 'partial' || s.itemsRemaining > 0);
  const state: FullSyncSummary['state'] = anyFailed ? 'failed' : anyIncomplete ? 'partial' : 'ok';

  return {
    // The first pass that ran names the run; every pass's own runId is in its summary.
    runId: ran[0]?.runId ?? 'none',
    state,
    durationMs: now() - startedAt,
    passes,
  };
}

/** The shared shell: open a run, seed, drain within budget, close with a verdict. */
async function runPass(
  config: AppConfig,
  deps: SyncPassDeps,
  spec: JobSpec,
): Promise<SyncPassSummary> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const startedAt = now();

  const wl = deps.wl ?? new WlClient(config.wl, { env: config.env });
  const db = deps.db ?? new SupabaseClient(config.supabase);
  const iso = (): string => new Date(now()).toISOString();
  const ctx: PassContext = {
    wl,
    db,
    kBusiness: config.wl.kBusiness,
    runId: wl.runId,
    nowIso: iso,
  };
  const handler = spec.makeHandler(ctx);

  await openRun(db, ctx.runId, ctx.kBusiness, spec.jobName, iso());
  await openJobState(db, spec.jobName, ctx.kBusiness, iso());

  const totals = { claimed: 0, done: 0, requeued: 0, dead: 0 };
  let failure: string | null = null;
  try {
    await spec.seed(ctx);
    for (;;) {
      // Budget is checked before starting a batch, never mid-item.
      if (now() - startedAt >= budgetMs) break;
      const s = await runQueue(db, handler, {
        now: iso(),
        workerId: ctx.runId,
        limit,
        leaseMs,
        workTypes: [spec.workType],
      });
      totals.claimed += s.claimed;
      totals.done += s.done;
      totals.requeued += s.requeued;
      totals.dead += s.dead;
      if (s.claimed === 0) break; // nothing eligible: the queue is drained
    }
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown error';
  }

  const itemsRemaining = await countEligible(db, iso(), spec.workType);
  const state: SyncPassSummary['state'] =
    failure !== null ? 'failed' : itemsRemaining > 0 ? 'partial' : 'ok';

  await closeRun(db, ctx.runId, iso(), {
    state,
    rowsFailed: totals.dead,
    itemsRemaining,
    tokenFetches: wl.tokenStatus().fetchCount,
    error: failure,
  });
  await closeJobState(db, spec.jobName, ctx.kBusiness, iso(), state);

  return {
    runId: ctx.runId,
    state,
    ...totals,
    itemsRemaining,
    ...(failure === null ? {} : { error: failure }),
  };
}

async function openRun(
  db: SupabaseClient,
  runId: string,
  kBusiness: string,
  jobName: string,
  startedAt: string,
): Promise<void> {
  await db.insert('sync_run', [
    {
      run_id: runId,
      job_name: jobName,
      k_business: kBusiness,
      started_at: startedAt,
      state: 'running',
    },
  ]);
}

async function closeRun(
  db: SupabaseClient,
  runId: string,
  finishedAt: string,
  outcome: {
    state: SyncPassSummary['state'];
    rowsFailed: number;
    itemsRemaining: number;
    tokenFetches: number;
    error: string | null;
  },
): Promise<void> {
  await db.update(
    'sync_run',
    {
      state: outcome.state,
      finished_at: finishedAt, // the constraint requires this once state != running
      rows_failed: outcome.rowsFailed,
      items_remaining: outcome.itemsRemaining,
      token_fetches: outcome.tokenFetches,
      ...(outcome.error === null ? {} : { error: outcome.error }),
    },
    `run_id=eq.${runId}`,
  );
}

/** How many of THIS job's items are claimable now - the measure of "work left". */
async function countEligible(db: SupabaseClient, now: string, workType: string): Promise<number> {
  // ponytail: caps the look at 1000; a queue past that is a scaling problem to
  // solve with a PostgREST count header, not a reason to block a pass today.
  const rows = await db.select(
    'sync_queue',
    `state=eq.pending&next_attempt_at=lte.${now}&work_type=eq.${workType}&limit=1000&select=id`,
  );
  return rows.length;
}
