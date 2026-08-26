import type { AppConfig } from '../config/schema.js';
import type { GhlSearchResponse } from '../ghl/client.js';
import { GhlRequestError } from '../ghl/client.js';
import { GHL_PATHS } from '../ghl/endpoint.js';
import { SupabaseClient } from '../supabase/client.js';
import { WlClient, WlRequestError } from '../wl/client.js';
import { WL_PATHS } from '../wl/endpoint.js';
import { fetchAllReportRows, MEMBER_STATUS_ACTIVATED } from '../wl/report.js';
import { WlTokenClient } from '../wl/token.js';
import { recordingGhl, storeRawGhl } from './ghl-writer.js';
import { closeJobState, openJobState } from './job-state.js';
import { writeClientList } from './clients.js';
import { writeLocationList } from './locations.js';
import { writeLoginTypeList } from './login-types.js';
import { writeMembership } from './memberships.js';
import { writePromotionList } from './promotions.js';
import { writePurchaseList } from './purchases.js';
import {
  enqueue,
  type FailureInfo,
  outcomeFromGhlError,
  outcomeFromWlError,
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

/**
 * Runs the client-list sync: the report that enumerates every activated client.
 *
 * This is the pass that closes the enumeration blocker. Every other person-
 * producing pass learns about a client from something else - a purchase, a
 * staff list - so the database only ever held people who had already done
 * something. This one asks WL who exists.
 *
 * ACTIVATED ONLY, DELIBERATELY. `o_member_status: [3]` is what the portal calls
 * "Activated Clients": 517 here, against 1,285 across every status. The other
 * 768 are overwhelmingly cancelled (713) or garbage profiles (22), and pulling
 * them would treble the row count and the storage for people nobody will ever
 * bill. Widening this is one constant, if that changes.
 *
 * ONE QUEUE ITEM, NOT ONE PER PAGE. The response carries no total, so the number
 * of pages is not known until the walk ends - there is nothing to fan out over
 * up front. At 500 rows a page this is 2 calls plus one poll each.
 */
export function runClientListSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'client_list_sync',
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
          const { fields, pages } = await fetchAllReportRows(
            wl,
            kBusiness,
            { memberStatuses: [MEMBER_STATUS_ACTIVATED] },
            { priorAttempt: item.attempt_count },
          );
          // Written page by page: one raw_wl row per payload, which is what
          // raw_link points at. Batching them would lose which page a person
          // came from.
          for (const page of pages) {
            await writeClientList(db, {
              kBusiness,
              runId,
              page,
              fields,
              syncedAt: nowIso(),
            });
          }
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
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
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
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
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
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
      const sessions = await db.select<{ k_period: string; dt_start_utc: string }>(
        'session',
        `k_business=eq.${kBusiness}&select=k_period,dt_start_utc`,
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
          const rows = await db.select<{ dtl_start_local: string }>(
            'session',
            `k_period=eq.${kPeriod}&dt_start_utc=eq.${encodeURIComponent(dtStartUtc)}` +
              `&select=dtl_start_local`,
          );
          const local = rows[0]?.dtl_start_local;
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

          const response = await wl.request(WL_PATHS.loginAttendanceList, {
            query: {
              dt_date_local: local.replace('T', ' ').slice(0, 19),
              k_class_period: kPeriod,
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
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
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
 * FUTURE ONLY, AND NO WINDOW TO WIDEN. /v1/schedule/page/list ignores date
 * parameters and returns upcoming visits. Fine for ongoing sync - a session is
 * caught while upcoming and its outcome filled in later - but it CANNOT
 * backfill. History is P9's problem, not this pass's.
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
      const people = await db.select<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&select=uid`,
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
          const known = await db.select<{
            k_visit: string;
            detail_fetch_count: number;
            dt_start_utc: string;
          }>(
            'attendance',
            `k_business=eq.${kBusiness}&uid=eq.${uid}&k_visit=not.is.null` +
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
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
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
      const people = await db.select<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&${filter}&select=uid`,
      );
      await enqueue(
        db,
        people.map((p) => ({
          work_type: 'ghl_contact_match',
          target_key: p.uid,
          k_business: kBusiness,
        })),
        nowIso(),
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
          }>('person', `uid=eq.${item.target_key}&select=uid,phone,email,ghl_unresolved_since`);
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

          for (const response of searches) {
            await storeRawGhl(db, {
              locationId: config.ghl.locationId,
              sourceEndpoint: GHL_PATHS.contactsSearch,
              response,
              runId,
              personUid: subject.uid,
            });
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
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
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
