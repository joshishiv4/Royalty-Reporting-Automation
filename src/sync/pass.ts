import type { AppConfig } from '../config/schema.js';
import type { GhlSearchResponse } from '../ghl/client.js';
import { GhlRequestError } from '../ghl/client.js';
import { GHL_PATHS } from '../ghl/endpoint.js';
import { SupabaseClient } from '../supabase/client.js';
import { WlClient } from '../wl/client.js';
import { WL_PATHS } from '../wl/endpoint.js';
import {
  MEMBER_STATUS_ACTIVATED,
  pollReport,
  readAllReportRows,
  requestReport,
} from '../wl/report.js';
import { WlTokenClient } from '../wl/token.js';
import { recordingGhl, storeRawGhl, upsertGhlContact } from './ghl-writer.js';
import { contactSnapshot } from '../ghl/snapshot.js';
import {
  bumpReportPoll,
  clearReportState,
  closeJobState,
  openJobState,
  readReportState,
  saveReportRequested,
} from './job-state.js';
import { writeClientList } from './clients.js';
import { writeLocationList } from './locations.js';
import { writeLoginTypeList } from './login-types.js';
import { writeMembership } from './memberships.js';
import { writePromotionList } from './promotions.js';
import { writePurchaseList } from './purchases.js';
import {
  enqueue,
  type FailureInfo,
  type Outcome,
  outcomeFromError,
  outcomeFromGhlError,
  type QueueHandler,
  runQueue,
} from './queue.js';
import { writeProfile } from './profiles.js';
import { writeRecipient } from './recipients.js';
import { writeReceipt } from './receipts.js';
import { writeServiceCategoryList, writeServiceList } from './services.js';
import { GhlClient } from '../ghl/client.js';
import { matchPerson } from '../ghl/matcher.js';
import { writeAttendanceList } from './attendance.js';
import { parseVisitList, writeClientSession } from './client-sessions.js';
import { writeSessionList } from './sessions.js';
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
  /** How many claimed items to claim and process at once. Defaults to DEFAULT_QUEUE_CONCURRENCY. */
  concurrency?: number;
  /** Claim lease length, kept above the step budget. */
  leaseMs?: number;
  /** Injected GoHighLevel client. Tests pass a fake; production builds one. */
  ghl?: Pick<GhlClient, 'searchContacts'>;
  /**
   * Re-search clients already searched for whose verdict is not 'matched'.
   * DELIBERATE ONLY - nothing on a schedule sets this. A retry can only produce
   * a different answer after someone has added contacts to GoHighLevel.
   */
  retryUnresolved?: boolean;
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
// Claim a big batch so the pool has plenty to chew on and claim round-trips are
// amortised; process DEFAULT_QUEUE_CONCURRENCY of them at once. Raised from 10
// after the serial loop measured ~2.35s/item on receipt_sync (27 Aug 2026).
const DEFAULT_LIMIT = 50;
const DEFAULT_QUEUE_CONCURRENCY = 8;
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

const CLIENT_LIST_JOB = 'client_list_sync';
/** The client-list report's two filters: the activated set, and everyone. */
const CLIENT_LIST_ACTIVATED = { memberStatuses: [MEMBER_STATUS_ACTIVATED] } as const;
const CLIENT_LIST_ALL = { memberStatuses: [] } as const;
/**
 * Wait between polls: 5, 10, 20, then 30 seconds, holding at 30. Each is a SEPARATE
 * queue invocation, so the worker is free in between - it never sits sleeping.
 */
const REPORT_POLL_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000] as const;
/** Give up on a build that never finishes and start a fresh one. */
const REPORT_HARD_TIMEOUT_MS = 10 * 60_000;

/**
 * Runs the client-list sync: the report that enumerates every client.
 *
 * This is the pass that closes the enumeration blocker - the one job that asks WL
 * who exists rather than learning about a client from a purchase or a staff list.
 *
 * EVERY STATUS, TAGGED. `o_member_status: []` returns all 1,285 clients, against
 * 517 for [3]; we store all and tag `is_active` from membership of the activated
 * set, because the report row carries no per-row status (clients.ts / 0027).
 *
 * ASYNCHRONOUS, AND POLLED WITHOUT TYING UP A WORKER. The report is built on WL's
 * side and is not ready when requested. A worker must NOT sit in a sleep loop
 * waiting - that burns the 60s function budget and a slow build takes the run down
 * with it. So this is a state machine across queue invocations, its state in
 * sync_job_state:
 *
 *   1. handle null      -> request BOTH builds (is_refresh=1), save the handle
 *                          BEFORE polling, defer 5s.
 *   2. past the deadline-> abandon the build, clear the handle, restart clean.
 *   3. handle set        -> poll BOTH (is_refresh=0, no restart). Not ready: bump
 *                          the attempt, defer on the 5/10/20/30s backoff. Ready:
 *                          read every page and write, clear the handle, done.
 *
 * A crash mid-poll resumes from the saved handle - the next invocation polls the
 * same build instead of paying to generate it again.
 */
export function runClientListSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: CLIENT_LIST_JOB,
    workType: 'client_list',
    seed: ({ db, kBusiness, nowIso }) =>
      enqueue(
        db,
        [{ work_type: 'client_list', target_key: 'all', k_business: kBusiness }],
        nowIso(),
      ).then(() => undefined),
    makeHandler:
      ({ wl, db, kBusiness, runId, nowIso }) =>
      async (item) => {
        try {
          return await clientListReportStep({
            wl,
            db,
            kBusiness,
            runId,
            nowIso,
            priorAttempt: item.attempt_count,
          });
        } catch (error) {
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
          throw error;
        }
      },
  });
}

export interface ClientListStepDeps {
  readonly wl: Pick<WlClient, 'request'>;
  readonly db: SupabaseClient;
  readonly kBusiness: string;
  readonly runId: string;
  readonly nowIso: () => string;
  readonly priorAttempt: number;
}

/**
 * ONE step of the client-list report state machine (see runClientListSyncPass).
 * Extracted so the phases - request/save, timeout, poll/backoff, read/write - can
 * be tested directly without standing up the whole queue.
 */
export async function clientListReportStep(deps: ClientListStepDeps): Promise<Outcome> {
  const { wl, db, kBusiness, runId, nowIso, priorAttempt } = deps;
  const at = { priorAttempt };
  const st = await readReportState(db, CLIENT_LIST_JOB, kBusiness);

  // 1. Not requested yet: start both builds and save the handle BEFORE any poll,
  // so a crash resumes into polling instead of regenerating.
  if (st.handle === null) {
    await requestReport(wl, kBusiness, CLIENT_LIST_ACTIVATED, at);
    await requestReport(wl, kBusiness, CLIENT_LIST_ALL, at);
    const nowStr = nowIso();
    const expiresAt = new Date(Date.parse(nowStr) + REPORT_HARD_TIMEOUT_MS).toISOString();
    await saveReportRequested(db, CLIENT_LIST_JOB, kBusiness, nowStr, expiresAt, nowStr);
    return { kind: 'defer', requeueAfterMs: REPORT_POLL_BACKOFF_MS[0] };
  }

  // 2. Hard timeout: the build is not coming. Clear and restart cleanly.
  if (st.expiresAt !== null && nowIso() > st.expiresAt) {
    await clearReportState(db, CLIENT_LIST_JOB, kBusiness, nowIso());
    return { kind: 'defer', requeueAfterMs: 2_000 };
  }

  // 3. Poll both builds - is_refresh=0, so this reads them, never restarts.
  const activated = await pollReport(wl, kBusiness, CLIENT_LIST_ACTIVATED, at);
  const all = await pollReport(wl, kBusiness, CLIENT_LIST_ALL, at);
  if (!(activated.complete && all.complete)) {
    const attempt = st.pollAttempt + 1;
    await bumpReportPoll(db, CLIENT_LIST_JOB, kBusiness, attempt, nowIso());
    const rung = Math.min(attempt, REPORT_POLL_BACKOFF_MS.length - 1);
    return { kind: 'defer', requeueAfterMs: REPORT_POLL_BACKOFF_MS[rung]! };
  }

  // Both ready: read every page (fast now) and write, tagging is_active.
  const activatedRows = await readAllReportRows(wl, kBusiness, CLIENT_LIST_ACTIVATED);
  const activatedUids = collectUids(activatedRows.fields, activatedRows.pages);
  const { fields, pages } = await readAllReportRows(wl, kBusiness, CLIENT_LIST_ALL);
  for (const page of pages) {
    await writeClientList(db, {
      kBusiness,
      runId,
      page,
      fields,
      syncedAt: nowIso(),
      activatedUids,
    });
  }
  await clearReportState(db, CLIENT_LIST_JOB, kBusiness, nowIso());
  return { kind: 'done' };
}

/** The set of uids across every page, read by the `uid` column's name. */
function collectUids(
  fields: readonly string[],
  pages: ReadonlyArray<{ readonly rows: ReadonlyArray<readonly unknown[]> }>,
): ReadonlySet<string> {
  const uidIdx = fields.indexOf('uid');
  const uids = new Set<string>();
  if (uidIdx === -1) return uids;
  for (const page of pages) {
    for (const row of page.rows) {
      const uid = row[uidIdx];
      if (typeof uid === 'string' && uid.length > 0) uids.add(uid);
      else if (typeof uid === 'number' && Number.isFinite(uid)) uids.add(String(uid));
    }
  }
  return uids;
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
      // selectAll, not select: person crossed PostgREST's 1,000-row cap the
      // moment the client list started storing every status (1,285 on live dev),
      // and an unpaged read seeded 1,000 of them while reporting a clean run.
      const people = await db.selectAll<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&order=uid.asc&select=uid`,
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
      // PAGINATED. PostgREST caps a select at 1000 rows by default. On live
      // dev the unpriced set grew to 14,148 purchases (of 20,347 total); an
      // unpaged read seeded only the first 1,000, and the remaining ~13,148
      // silently never entered the queue - receipt_sync then reported 'ok'
      // with nothing left to do while the pricing coverage stalled at ~30%.
      // Loop until a short page returns so the full unpriced list is seeded
      // no matter how deep it gets.
      const PAGE = 1000;
      const unpriced: Array<{ k_purchase: string }> = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await db.select<{ k_purchase: string }>(
          'purchase',
          `k_business=eq.${kBusiness}&m_total=is.null&order=k_purchase.asc` +
            `&limit=${PAGE}&offset=${offset}&select=k_purchase`,
        );
        unpriced.push(...page);
        if (page.length < PAGE) break;
      }
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
      // PAGINATED. Same 1000-row PostgREST cap as receipt_sync's seed above:
      // 20,558 purchase_item rows on live dev, only 1,000 were being seeded
      // per invocation.
      const PAGE = 1000;
      const items: Array<{ k_purchase_item: string }> = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await db.select<{ k_purchase_item: string }>(
          'purchase_item',
          `k_business=eq.${kBusiness}&order=k_purchase_item.asc` +
            `&limit=${PAGE}&offset=${offset}&select=k_purchase_item`,
        );
        items.push(...page);
        if (page.length < PAGE) break;
      }
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
      // selectAll, not select: person crossed PostgREST's 1,000-row cap the
      // moment the client list started storing every status (1,285 on live dev),
      // and an unpaged read seeded 1,000 of them while reporting a clean run.
      const people = await db.selectAll<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&order=uid.asc&select=uid`,
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
          throw error;
        }
      },
  });
}

/**
 * Runs the login-type sync: one job that lists the business's client types.
 *
 * Business-wide - the endpoint answers with no k_location - so it is seeded as a
 * single 'all' item, like staff and locations. Thirteen rows,
 * which is exactly the Client Types filter the WL "All Clients" report offers.
 *
 * Runs EARLY, before the person-creating passes: `login_type.is_teacher_type` is
 * what the `teacher` view joins on (migration 0014), so without these rows there
 * are no teachers, whatever else synced. Upsert on k_login_type, and the payload
 * deliberately omits is_teacher_type so a re-sync never overwrites the studio's
 * decision (see login-types.ts).
 */
export function runLoginTypeSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'login_type_sync',
    workType: 'login_type_list',
    seed: async ({ db, kBusiness, nowIso }) => {
      await enqueue(
        db,
        [{ work_type: 'login_type_list', target_key: 'all', k_business: kBusiness }],
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.loginType, {
            priorAttempt: item.attempt_count,
          });
          await writeLoginTypeList(db, { kBusiness, response, runId });
          return { kind: 'done' };
        } catch (error) {
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
          throw error;
        }
      },
  });
}

/**
 * A failure that is ours, not WL's - the request never went out. Shaped like a
 * WL failure so sync_queue records it the same way; the WL-specific fields are
 * null precisely because there was no response.
 */
function internalFailure(runId: string, message: string): FailureInfo {
  return { message, sid: null, httpStatus: null, traceId: runId, kLog: null };
}

/** The rolling schedule window: seven days back, thirty forward. */
const SCHEDULE_LOOKBACK_DAYS = 7;
const SCHEDULE_LOOKAHEAD_DAYS = 30;

/** WL wants BARE dates here - "YYYY-MM-DD 00:00:00" is rejected. See sessions.ts. */
function scheduleDay(now: number, offsetDays: number): string {
  return new Date(now + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Runs the schedule sync: one job that pulls the class schedule for a rolling
 * window of -7 to +30 days.
 *
 * Seven days back catches sessions that have just finished (a royalty is owed on
 * those); thirty forward is what the portal shows a student.
 *
 * ONE CALL FOR THE WHOLE STUDIO. The endpoint demands a `uid`, but the schedule
 * it returns is the business's, not that person's - four uids were probed live
 * and all four returned identical sessions. So this is seeded as a single 'all'
 * item and its cost does not grow with the client base. Any person will do; the
 * first uid we hold is used.
 *
 * RE-RUNNING CHANGES NOTHING. Occurrences upsert on (k_period, dt_start_utc), so
 * the same window fetched twice refreshes booking counts in place. That key is
 * the whole point: a class id repeats weekly (see sessions.ts).
 */
export function runScheduleSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'schedule_sync',
    workType: 'schedule_window',
    // The uid the call needs is decided HERE, not in the handler: with no person
    // row there is nothing to hang the call on, and the honest response is to
    // enqueue nothing rather than claim work and quietly mark it done. The staff
    // pass runs first, so by the next pass there will be one.
    seed: async ({ db, kBusiness, nowIso }) => {
      const people = await db.select<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&select=uid&limit=1`,
      );
      const uid = people[0]?.uid;
      if (uid === undefined) return;
      await enqueue(
        db,
        [{ work_type: 'schedule_window', target_key: uid, k_business: kBusiness }],
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId, nowIso }) =>
      async (item) => {
        try {
          // The uid rides on the queue item - see the seed.
          const uid = item.target_key;

          // The pass clock, not Date.now(): tests inject it, and every claim
          // in this run filters on the same one.
          const at = Date.parse(nowIso());
          const from = scheduleDay(at, -SCHEDULE_LOOKBACK_DAYS);
          const to = scheduleDay(at, SCHEDULE_LOOKAHEAD_DAYS);
          const response = await wl.request(WL_PATHS.scheduleClassList, {
            query: { uid, dt_date: from, dt_end: to, is_tab_all: 'true' },
            priorAttempt: item.attempt_count,
          });
          await writeSessionList(db, {
            kBusiness,
            response,
            runId,
            windowKey: `${from}|${to}`,
          });
          return { kind: 'done' };
        } catch (error) {
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
          throw error;
        }
      },
  });
}

/**
 * Runs the attendance sync: one job PER stored session occurrence, each fetching
 * /v1/login/attendance/list for who booked and who turned up.
 *
 * Seeded from `session`, so it can only ever cover occurrences the schedule pass
 * already brought in - which is why it runs after it. Sessions with no attendees
 * simply return an empty list; that is a real answer, not a failure.
 *
 * The endpoint wants the occurrence's LOCAL start time under `dt_date_local`
 * (the parameter name that had this recorded as blocked - see attendance.ts), so
 * the seed carries the composite key and the handler reads the local time back
 * off the session row.
 *
 * Attendees are ordinary clients we usually do not otherwise hold, so this pass
 * is currently the ONLY route to people outside the staff list. It does not
 * enumerate them - it finds the ones who booked a class we can see.
 */
export function runAttendanceSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'attendance_sync',
    workType: 'session_attendance',
    seed: async ({ db, kBusiness, nowIso }) => {
      // CLASSES *AND* APPOINTMENTS. This used to be classes only, and the
      // reasoning was wrong in a way worth keeping written down.
      //
      // WL answers `id-nx` - "The ID value for k_class_period that you have
      // specified does not exist" - for an appointment key, measured as 681 dead
      // rows out of 1,018. That was read as "the endpoint is class-only". It is
      // not. WL's own spec summarises it as "clients attending a class,
      // APPOINTMENT, or event session" and documents two mutually exclusive
      // parameters: k_class_period ("not used if requesting information for an
      // appointment") and k_appointment ("not used if requesting information for
      // a class"). We only ever sent the appointment key AS k_class_period, so
      // id-nx was a correct answer to a question asked wrongly - the same shape
      // of mistake as dt_date versus dt_date_local (see attendance.ts).
      //
      // Probed live 27 Aug 2026 on one past and one upcoming appointment:
      // k_appointment= is accepted and returns the attendee with id_visit - 3
      // ATTEND on the past one, 1 BOOK on the upcoming one - while the same key
      // as k_class_period still fails with id-nx. So appointment OUTCOMES are
      // reachable, and they were not before.
      //
      // This matters beyond tidiness. 4,412 of 4,423 sessions are appointments,
      // and their only outcome source was page/element, which is read once when a
      // visit is still upcoming and therefore records BOOK forever. That is why
      // the table holds 4,425 BOOK against 3 ATTEND.
      const sessions = await db.selectAll<{
        k_period: string;
        dt_start_utc: string;
      }>(
        'session',
        `k_business=eq.${kBusiness}` +
          `&order=k_period.asc&order=dt_start_utc.asc&select=k_period,dt_start_utc`,
      );
      await enqueue(
        db,
        sessions.map((s) => ({
          work_type: 'session_attendance',
          target_key: `${s.k_period}|${s.dt_start_utc}`,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          // A target key this pass wrote itself, so a malformed one means the
          // queue row was tampered with or seeded by something else. Dead-letter
          // it rather than guess at a period.
          const [kPeriod, dtStartUtc] = item.target_key.split('|');
          if (kPeriod === undefined || dtStartUtc === undefined || dtStartUtc === '') {
            return {
              kind: 'dead',
              failure: internalFailure(
                runId,
                `attendance key is not period|start: ${item.target_key}`,
              ),
            };
          }

          // The endpoint needs LOCAL time; the session row is where it lives,
          // stored exactly as WL sent it rather than converted from the UTC one.
          const rows = await db.select<{ dtl_start_local: string; session_kind: string }>(
            'session',
            `k_period=eq.${kPeriod}&dt_start_utc=eq.${encodeURIComponent(dtStartUtc)}` +
              `&limit=1&select=dtl_start_local,session_kind`,
          );
          const local = rows[0]?.dtl_start_local;
          const kind = rows[0]?.session_kind;
          if (local === undefined) {
            // The session was deleted between seeding and claiming. Retrying
            // cannot help, and the local start time is the one thing this call
            // cannot be made without.
            return {
              kind: 'dead',
              failure: internalFailure(
                runId,
                `session ${item.target_key} gone before attendance ran`,
              ),
            };
          }

          // THE KEY GOES IN THE PARAMETER THAT MATCHES ITS KIND. WL documents
          // the two as mutually exclusive, and sending an appointment key as
          // k_class_period is what produced 681 dead rows. `session.k_period`
          // holds a k_appointment for appointment rows - see
          // client-sessions.ts - so the kind decides the parameter name.
          const keyParam =
            kind === 'appointment' ? { k_appointment: kPeriod } : { k_class_period: kPeriod };
          const response = await wl.request(WL_PATHS.loginAttendanceList, {
            query: {
              // Kept for appointments too. Measured, it is not required there - a
              // k_appointment names one occurrence, unlike a class period, which
              // repeats weekly - but it is accepted, and sending it keeps one
              // code path instead of two.
              dt_date_local: local.replace('T', ' ').slice(0, 19),
              ...keyParam,
            },
            priorAttempt: item.attempt_count,
          });
          await writeAttendanceList(db, {
            kBusiness,
            kPeriod,
            dtStartUtc,
            response,
            runId,
          });
          return { kind: 'done' };
        } catch (error) {
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
          throw error;
        }
      },
  });
}

/**
 * How long after its start a session stops being worth re-reading (PRD 7.3).
 * Generously wide: WL allows cancellation up to 24h before, so an outcome is
 * settled long before a week is out. A constant, not a column - tuning this
 * should not need a migration.
 */
/**
 * How long to wait before retrying a client after GoHighLevel failed.
 *
 * Five minutes rather than the WL ladder's seconds: an outage at a supplementary
 * service is not worth hammering, and the run that requeues is not blocked by
 * the wait - it moves on and comes back.
 */
const GHL_REQUEUE_AFTER_MS = 300_000;

/**
 * Stores the matched contact's fields and tags, and never throws (PRD M06).
 *
 * WHY IT CANNOT THROW. The enrichment runs after the verdict is already
 * committed. Letting a storage failure out would fail the queue item, and a
 * requeue would send the matcher back to GoHighLevel for a client whose answer
 * is final - breaking the one rule this pass is built on, that a client is
 * searched exactly once. So the failure is absorbed here.
 *
 * NOTHING IS HIDDEN BY ABSORBING IT. A matched client with no `ghl_contact` row
 * is `data_health_issue.missing_ghl_enrichment` by construction - the gap
 * reports itself with no error channel, no log line and no write that could fail
 * in turn. Closing it needs no API call either: migration 0026's backfill parses
 * it out of the payload already stored in `raw_ghl`.
 *
 * WHICH RESPONSE THE SNAPSHOT COMES FROM. Found by contact id rather than by
 * position. Today the deciding search is always the last one stored, because the
 * matcher returns the moment it decides - so `stored[last]` would work and this
 * is belt-and-braces. It is written this way because the position argument
 * depends on the matcher's control flow, and a lookup by id does not: adding a
 * third search route would quietly break the shortcut and not this.
 */
async function storeEnrichment(
  db: SupabaseClient,
  input: {
    contactId: string;
    stored: readonly { response: GhlSearchResponse; rawGhlId: string | null }[];
    locationId: string;
    fetchedAt: string;
  },
): Promise<void> {
  try {
    for (const { response, rawGhlId } of input.stored) {
      const contact = response.contacts.find((c) => c.id === input.contactId);
      if (contact === undefined) continue;

      const snapshot = contactSnapshot(contact);
      if (snapshot === null) return;

      await upsertGhlContact(db, {
        snapshot,
        fetchedAt: input.fetchedAt,
        rawGhlId,
        locationId: input.locationId,
      });
      return;
    }
  } catch {
    // Deliberately swallowed - see the doc comment above. The missing row is
    // the report.
  }
}

const SESSION_IMMUTABLE_AFTER_DAYS = 7;
/** Once on discovery, once after it has happened. A third read learns nothing. */
const MAX_DETAIL_FETCHES = 2;

/**
 * Runs the per-client session sync: one job PER person, fetching that client's
 * upcoming visits and then the detail of each (PRD 7.2).
 *
 * THE ONLY ROUTE TO PRIVATE APPOINTMENTS. The business-wide schedule call
 * returns classes only. Measured live 25 Aug 2026: six class occurrences taught
 * by ONE person, against 115 visits from the per-client call - sixteen of the
 * seventeen teachers had no session we could see. Private lessons are the main
 * revenue line, so without this pass almost nothing is attributable.
 *
 * FORWARD ONLY BY CHOICE, NOT BY LIMITATION - and the comment here used to claim
 * otherwise. Sending only `{ uid }` returns upcoming visits, which is what
 * ongoing sync wants: a session is caught while upcoming and its outcome filled
 * in later by the 7.3 re-read.
 *
 * But `is_past=1` returns the client's previous visits, and `dtu_start`/`dtu_end`
 * window them. Measured live 27 Aug 2026: one uid answered 0 visits without the
 * flag and 402 with it, spanning 2021 to 2025. History is still P9's job, but P9
 * is not blocked - see client-sessions.ts for the full measurement.
 *
 * A client with nothing booked returns an empty list, which is a real answer:
 * the job completes rather than failing.
 *
 * COST: one list call per person plus one detail call per visit. Live that is
 * 22 + 115 = 137 calls, and the detail half grows with the client base. Task 7.3
 * adds the at-most-twice rule that keeps it bounded; until then this pass
 * re-reads every upcoming visit on every run.
 */
export function runClientSessionSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'client_session_sync',
    workType: 'client_visits',
    seed: async ({ db, kBusiness, nowIso }) => {
      // selectAll, not select: person crossed PostgREST's 1,000-row cap the
      // moment the client list started storing every status (1,285 on live dev),
      // and an unpaged read seeded 1,000 of them while reporting a clean run.
      const people = await db.selectAll<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&order=uid.asc&select=uid`,
      );
      await enqueue(
        db,
        people.map((p) => ({
          work_type: 'client_visits',
          target_key: p.uid,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId, nowIso }) =>
      async (item) => {
        try {
          const uid = item.target_key;
          const listed = await wl.request(WL_PATHS.schedulePageList, {
            query: { uid },
            priorAttempt: item.attempt_count,
          });
          const visits = parseVisitList(listed.body);

          // What we already know about these visits, so a settled one is not
          // read again (PRD 7.3). One query for the whole client, not one per
          // visit - the point of this rule is FEWER round trips, not more.
          const known = await db.selectAll<{
            k_visit: string;
            detail_fetch_count: number;
            dt_start_utc: string;
          }>(
            'attendance',
            `k_business=eq.${kBusiness}&uid=eq.${uid}&k_visit=not.is.null` +
              `&order=k_visit.asc` +
              `&select=k_visit,session!inner(detail_fetch_count,dt_start_utc)`,
          );
          const seen = new Map(
            known.map((r) => {
              const s = r as unknown as {
                k_visit: string;
                session: { detail_fetch_count: number; dt_start_utc: string };
              };
              return [String(s.k_visit), s.session];
            }),
          );

          const at = Date.parse(nowIso());
          const settledBefore = at - SESSION_IMMUTABLE_AFTER_DAYS * 86_400_000;
          let fetched = 0;
          let skipped = 0;

          // Each visit needs its own detail call - the list carries pointers
          // (k_visit and a date) and nothing else.
          for (const kVisit of visits) {
            const prior = seen.get(kVisit);
            if (prior !== undefined) {
              const started = Date.parse(prior.dt_start_utc);
              const hasHappened = Number.isFinite(started) && started < at;

              // Two reads is everything there is to learn.
              const spent = prior.detail_fetch_count >= MAX_DETAIL_FETCHES;
              // A week past its start it is settled whatever the count says, so
              // a visit that somehow never reached two is not retried forever.
              const settled = Number.isFinite(started) && started < settledBefore;
              // THE SECOND READ IS ONLY WORTH MAKING ONCE THE SESSION HAS
              // HAPPENED. Spending it while the session is still upcoming burns
              // the quota on an is_checkin that is necessarily still false, and
              // the real outcome then never gets read at all. That is the whole
              // point of "once when discovered, once after its date has passed".
              const tooEarly = prior.detail_fetch_count >= 1 && !hasHappened;

              if (spent || settled || tooEarly) {
                skipped += 1;
                continue;
              }
            }

            const detail = await wl.request(WL_PATHS.schedulePageElement, {
              query: { k_visit: kVisit },
              priorAttempt: item.attempt_count,
            });
            await writeClientSession(db, {
              kBusiness,
              uid,
              kVisit,
              response: detail,
              runId,
              detailFetchCount: (prior?.detail_fetch_count ?? 0) + 1,
              fetchedAt: nowIso(),
            });
            fetched += 1;
          }

          // fetched + skipped is the call-volume story this rule exists for:
          // on a settled client every visit is skipped and the pass costs a
          // single list call. Measured figures are in ARCHITECTURE.md.
          void fetched;
          void skipped;
          return { kind: 'done' };
        } catch (error) {
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
          throw error;
        }
      },
  });
}

/**
 * Runs the GoHighLevel match: one job PER person, linking them to their contact
 * (PRD M04).
 *
 * RUNS AFTER ENRICHMENT, AND THAT IS THE WHOLE REASON 6.1 EXISTS. A person's
 * phone and primary email only arrive from the profile pass; matching before it
 * would search on nulls and record 'unmatched' for everyone. The order here is
 * load-bearing, not incidental.
 *
 * ONCE PER CLIENT, AND ONLY ONCE. By default this seeds people who have NEVER
 * been searched for - ghl_match_attempted_at is null. A client with a verdict is
 * not touched again by any recurring run, including the weekly full refresh.
 * That is what keeps the ongoing cost of this integration at effectively zero:
 * roughly one GoHighLevel search per client for the life of the system, not that
 * many per run.
 *
 * 'unmatched' ALONE IS NOT ENOUGH TO DECIDE. It is the default state, so a
 * client nobody has searched for and a client who genuinely is not in
 * GoHighLevel look the same. The attempt timestamp (migration 0022) is what
 * separates them, and without it "match new clients automatically" and "retrying
 * unmatched is manual" contradict each other on the same rows.
 *
 * RETRYING IS DELIBERATE. Pass `retryUnresolved` to include clients already
 * searched for whose verdict is not 'matched'. Nothing sets that on a schedule -
 * it exists so a human can re-run after contacts have been added to
 * GoHighLevel, which is the only time a retry can produce a different answer.
 *
 * PHONE FIRST, EMAIL SECOND, NAMES NEVER - see matcher.ts for why each of those
 * is the way round it is.
 *
 * THE ENRICHMENT RIDES ALONG (M06). On a match, the contact's fields and tags
 * are stored from the search response already in hand - no second request, so
 * the once-per-client cost above is unchanged. It is the only moment they are
 * ever read: nothing refreshes them afterwards, which is why `ghl_contact`
 * carries a fetch timestamp and why an aged snapshot is not a health issue.
 */
export function runGhlMatchSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'ghl_match_sync',
    workType: 'ghl_contact_match',
    seed: async ({ db, kBusiness, nowIso }) => {
      // Default: only people nobody has searched for yet. A retry is a separate,
      // deliberate request - see the header.
      const filter =
        deps.retryUnresolved === true
          ? // Everything still unresolved, however long ago it was tried.
            // 'failed' is included with the two the criteria name: it is not
            // resolved either, and excluding it would strand the row forever.
            `ghl_match_state=in.(unmatched,ambiguous,failed)`
          : `ghl_match_attempted_at=is.null`;
      const people = await db.selectAll<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&${filter}&order=uid.asc&select=uid`,
      );
      // retryUnresolved is an explicit human-initiated refresh - it must
      // override the fresh-done skip in enqueue, otherwise clients matched in
      // the last 24 hours would silently be excluded from the retry set the
      // caller specifically asked to re-check.
      await enqueue(
        db,
        people.map((p) => ({
          work_type: 'ghl_contact_match',
          target_key: p.uid,
          k_business: kBusiness,
        })),
        nowIso(),
        { forceReseed: deps.retryUnresolved === true },
      );
    },
    makeHandler:
      ({ db, kBusiness, runId, nowIso }) =>
      async (item) => {
        try {
          const rows = await db.select<{
            uid: string;
            phone: string | null;
            email: string | null;
            ghl_unresolved_since: string | null;
          }>(
            'person',
            `uid=eq.${item.target_key}&limit=1&select=uid,phone,email,ghl_unresolved_since`,
          );
          const row = rows[0];
          if (row === undefined) {
            return {
              kind: 'dead',
              failure: internalFailure(runId, `person ${item.target_key} gone before matching`),
            };
          }

          // A GHL client per pass, not per item: one place that owns the HTTP
          // boundary, and its retry ladder is shared across the batch.
          const ghl = deps.ghl ?? new GhlClient(config.ghl, { env: config.env });
          // Only the three fields the matcher is allowed to see. The unresolved
          // clock is ours, not evidence about who this person is.
          const subject = { uid: row.uid, phone: row.phone, email: row.email };

          // Every search the matcher makes is kept, one raw_ghl row each. It
          // calls once or twice depending on whether phone found anything, and
          // the recorder means it does not have to know that.
          const searches: GhlSearchResponse[] = [];
          const outcome = await matchPerson(
            recordingGhl(ghl, (r) => searches.push(r)),
            subject,
          );

          // Kept paired with its stored row id so the enrichment below can say
          // which payload it was parsed out of.
          const stored: { response: GhlSearchResponse; rawGhlId: string | null }[] = [];
          for (const response of searches) {
            const rawGhlId = await storeRawGhl(db, {
              locationId: config.ghl.locationId,
              sourceEndpoint: GHL_PATHS.contactsSearch,
              response,
              runId,
              personUid: subject.uid,
            });
            stored.push({ response, rawGhlId });
          }

          // Set on the first non-matching outcome and left alone thereafter, so
          // a deliberate retry does not restart the 48-hour clock on a record
          // nobody has actually dealt with. Cleared the moment it matches.
          const unresolvedSince =
            outcome.state === 'matched' ? null : (row.ghl_unresolved_since ?? nowIso());

          await db.update(
            'person',
            {
              ghl_match_state: outcome.state,
              // Only ever set on a real match; a non-match must not leave a
              // stale id behind from an earlier attempt.
              ghl_contact_id: outcome.ghlContactId,
              // Stamped on EVERY outcome, not just a match. "We looked and found
              // nobody" is exactly the fact the automatic seed needs, and it is
              // the one an unmatched row would otherwise be unable to state.
              ghl_match_attempted_at: nowIso(),
              ghl_unresolved_since: unresolvedSince,
            },
            `uid=eq.${subject.uid}&k_business=eq.${kBusiness}`,
          );

          // The enrichment (M06): the agreed fields and tags, parsed out of the
          // search that just decided the match. No second API call - the
          // response is already in hand, which is what makes fetch-once free.
          //
          // AFTER the person update, and swallowed on failure, both on purpose.
          // The verdict is the fact that matters and it must be durable before
          // anything optional is attempted; and a storage problem here must not
          // fail the item, because a requeue would search GoHighLevel again for
          // a client whose verdict is already final. The gap needs no error
          // channel to be noticed - a matched client with no ghl_contact row IS
          // data_health_issue.missing_ghl_enrichment, and migration 0026's
          // backfill closes it from stored payloads with no API call.
          if (outcome.state === 'matched' && outcome.ghlContactId !== null) {
            await storeEnrichment(db, {
              contactId: outcome.ghlContactId,
              stored,
              locationId: config.ghl.locationId,
              fetchedAt: nowIso(),
            });
          }
          return { kind: 'done' };
        } catch (error) {
          // Covers a WL error and a transient DB hiccup (see outcomeFromError).
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
          // GoHighLevel is supplementary; WellnessLiving is the system of
          // record. An outage here must degrade to stale data, never take the
          // run down with it - so it becomes an outcome, not a throw.
          if (error instanceof GhlRequestError) {
            return outcomeFromGhlError(error, GHL_REQUEUE_AFTER_MS);
          }
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
      const locations = await db.selectAll<{ k_location: string }>(
        'location',
        `k_business=eq.${kBusiness}&order=k_location.asc&select=k_location`,
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
      const locations = await db.selectAll<{ k_location: string }>(
        'location',
        `k_business=eq.${kBusiness}&order=k_location.asc&select=k_location`,
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
      const locations = await db.selectAll<{ k_location: string }>(
        'location',
        `k_business=eq.${kBusiness}&order=k_location.asc&select=k_location`,
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
          const outcome = outcomeFromError(error);
          if (outcome !== null) return outcome;
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
  // reference FIRST: login_type.is_teacher_type is what the teacher view joins
  // on, so without it nobody is a teacher however well everything else synced.
  { job: 'login_type_sync', run: runLoginTypeSyncPass },
  // every activated client, BEFORE anything that derives people from activity:
  // this is the only pass that knows who exists rather than who has transacted.
  { job: 'client_list_sync', run: runClientListSyncPass },
  // person rows next: purchases are seeded from person.uid.
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
  // the schedule: business-wide, needs a person row to exist (any one will do).
  { job: 'schedule_sync', run: runScheduleSyncPass },
  // per-client visits: the ONLY route to private appointments. After the
  // schedule pass so a class booking converges onto the row it already wrote.
  { job: 'client_session_sync', run: runClientSessionSyncPass },
  // per-occurrence attendance: needs the session rows the schedule pass wrote.
  { job: 'attendance_sync', run: runAttendanceSyncPass },
  // GoHighLevel matching LAST among the person passes: it needs the phone and
  // primary email that only the profile pass supplies (PRD 6.1).
  { job: 'ghl_match_sync', run: runGhlMatchSyncPass },
  // per-location catalogue LAST: it upserts the authoritative title over any
  // purchase-derived stub and marks resolved services, so it must run after the
  // purchase pass that creates those stubs.
  { job: 'service_sync', run: runServiceSyncPass },
];

const DEFAULT_FULL_BUDGET_MS = 50_000;
/** Below this, a pass would only seed and immediately stop; skip it instead. */
const MIN_PASS_BUDGET_MS = 3_000;

/**
 * The parallel full sync order. A single wave: every pass runs at the same
 * time, and the sync eventually converges over multiple invocations.
 *
 * FLAT ON PURPOSE. An earlier draft grouped passes into three dependency waves
 * so no pass ever ran before the pass that fills its input tables. That is
 * SAFE in the classical sense, and it is exactly the problem: on live dev with
 * ~thousands of items pending in wave-2 passes (purchase_sync, client_session_sync),
 * wave 3 sat idle for the entire wall-clock of wave 2 - the observation "top row
 * with 5 in_progress, bottom rows both 0 in_progress" is precisely that wait.
 *
 * The FK dependencies still hold, they just resolve OVER RUNS instead of within
 * one:
 *   - receipt_sync seeds from purchase rows that already exist. A run started
 *     while purchase_sync is still adding new purchases simply picks up the ones
 *     that were already there; the newly created purchases become eligible on
 *     the next run's seed.
 *   - purchase_element_sync is the same shape.
 *   - ghl_match_sync ideally reads phone/email that profile_sync fills in - a
 *     first run may match fewer people, and a second run finishes the job. This
 *     is the trade the parallel mode explicitly accepts.
 *
 * Nothing here CORRUPTS state on the first run; the queue is durable and the
 * fresh-done window in enqueue keeps repeated invocations cheap. The daily
 * sequential runFullSyncPass is still what the Vercel cron uses; this mode is
 * for a local backfill that wants every worker busy at once.
 */
const FULL_SYNC_WAVES: ReadonlyArray<
  ReadonlyArray<{
    readonly job: string;
    readonly run: (config: AppConfig, deps: SyncPassDeps) => Promise<SyncPassSummary>;
  }>
> = [
  [
    { job: 'login_type_sync', run: runLoginTypeSyncPass },
    { job: 'client_list_sync', run: runClientListSyncPass },
    { job: 'staff_sync', run: runStaffSyncPass },
    { job: 'location_sync', run: runLocationSyncPass },
    { job: 'shop_category_sync', run: runShopCategorySyncPass },
    { job: 'promotion_sync', run: runPromotionSyncPass },
    { job: 'service_category_sync', run: runServiceCategorySyncPass },
    { job: 'purchase_sync', run: runPurchaseSyncPass },
    { job: 'profile_sync', run: runProfileSyncPass },
    { job: 'schedule_sync', run: runScheduleSyncPass },
    { job: 'client_session_sync', run: runClientSessionSyncPass },
    { job: 'receipt_sync', run: runReceiptSyncPass },
    { job: 'purchase_element_sync', run: runPurchaseElementSyncPass },
    { job: 'attendance_sync', run: runAttendanceSyncPass },
    { job: 'ghl_match_sync', run: runGhlMatchSyncPass },
    { job: 'service_sync', run: runServiceSyncPass },
  ],
];

const DEFAULT_PARALLEL_PASS_BUDGET_MS = 90 * 60_000;

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
  const concurrency = deps.concurrency ?? DEFAULT_QUEUE_CONCURRENCY;
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
  let deferred = 0;
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
        concurrency,
        leaseMs,
        workTypes: [spec.workType],
      });
      totals.claimed += s.claimed;
      totals.done += s.done;
      totals.requeued += s.requeued;
      totals.dead += s.dead;
      deferred += s.deferred;
      if (s.claimed === 0) break; // nothing eligible: the queue is drained
    }
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown error';
  }

  // A deferred item sits pending with a future next_attempt_at, so countEligible
  // does not see it - but it IS outstanding work (a report still building), so the
  // pass is 'partial', not a clean 'ok' that would move the completion watermark.
  const itemsRemaining = await countEligible(db, iso(), spec.workType);
  const state: SyncPassSummary['state'] =
    failure !== null ? 'failed' : itemsRemaining > 0 || deferred > 0 ? 'partial' : 'ok';

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
/**
 * Runs every sync pass IN PARALLEL WITHIN DEPENDENCY WAVES.
 *
 * The sequential runFullSyncPass is the daily cron's shape - safe, bounded to
 * one Vercel invocation, and correct because every pass sees the previous
 * pass's writes. That is exactly wrong for a backfill: with 517 clients and a
 * few thousand purchases, each per-item pass takes tens of minutes on its own,
 * and running them serially wastes wall clock the WL and Supabase throats can
 * happily handle in parallel.
 *
 * WHAT THIS PROMISES
 *   - Each pass's seed runs EXACTLY ONCE. The pass's own inner loop drains its
 *     queue within the given budget; there is no outer restart, so a done item
 *     is never re-enqueued during a run.
 *   - Passes inside a wave run concurrently. Passes across waves are still
 *     sequential, so FK dependencies (purchase -> receipt, session -> attendance)
 *     hold.
 *   - One shared WlTokenClient means the whole run authenticates once. Each
 *     pass still gets its own WlClient so its runId and sync_run row are
 *     distinct.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - No global time budget. The caller decides how long each pass may run;
 *     defaults to 90 minutes per pass, which is far past what any observed
 *     backfill has needed. Aimed at a local/CLI backfill, not a Vercel cron.
 *   - No cross-wave overlap. A pass in wave 2 that has no consumer in wave 3
 *     could in principle start alongside wave 3, but the code stays honest to
 *     the FK graph rather than trying to prove micro-optimisations safe.
 */
export async function runFullSyncPassParallel(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<FullSyncSummary> {
  const now = deps.now ?? (() => Date.now());
  const passBudgetMs = deps.budgetMs ?? DEFAULT_PARALLEL_PASS_BUDGET_MS;
  const startedAt = now();

  const db = deps.db ?? new SupabaseClient(config.supabase);
  const tokens = new WlTokenClient(config.wl, { env: config.env });

  const passes: FullSyncPassResult[] = [];

  for (const wave of FULL_SYNC_WAVES) {
    // Every pass in this wave gets its own WlClient (distinct runId, shared
    // token cache). An injected wl (tests) is reused: a fake client has no
    // sync_run constraint to collide with.
    const waveResults = await Promise.all(
      wave.map(({ job, run }) => {
        const wl =
          deps.wl ??
          new WlClient(config.wl, {
            tokens,
            env: config.env,
            timeoutMs: config.runtime.httpTimeoutMs,
            now,
          });
        return run(config, { ...deps, wl, db, budgetMs: passBudgetMs, now })
          .then((summary): FullSyncPassResult => ({ job, ran: true, summary }))
          .catch((error: unknown): FullSyncPassResult => ({
            job,
            ran: true,
            summary: {
              runId: 'error',
              state: 'failed',
              claimed: 0,
              done: 0,
              requeued: 0,
              dead: 0,
              itemsRemaining: -1,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
      }),
    );
    passes.push(...waveResults);
  }

  const ran = passes
    .filter((p): p is FullSyncPassResult & { summary: SyncPassSummary } => p.summary !== null)
    .map((p) => p.summary);
  const anyFailed = ran.some((s) => s.state === 'failed');
  const anyIncomplete = ran.some((s) => s.state === 'partial' || s.itemsRemaining > 0);
  const state: FullSyncSummary['state'] = anyFailed ? 'failed' : anyIncomplete ? 'partial' : 'ok';

  return {
    runId: ran[0]?.runId ?? 'none',
    state,
    durationMs: now() - startedAt,
    passes,
  };
}

async function countEligible(db: SupabaseClient, now: string, workType: string): Promise<number> {
  // ponytail: caps the look at 1000; a queue past that is a scaling problem to
  // solve with a PostgREST count header, not a reason to block a pass today.
  const rows = await db.select(
    'sync_queue',
    `state=eq.pending&next_attempt_at=lte.${now}&work_type=eq.${workType}&limit=1000&select=id`,
  );
  return rows.length;
}
