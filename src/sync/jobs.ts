import type { AppConfig } from '../config/schema.js';
import type { SyncPassDeps, SyncPassSummary } from './pass.js';
import {
  runAttendanceSyncPass,
  runClientListSyncPass,
  runClientSessionSyncPass,
  runGhlMatchSyncPass,
  runLocationSyncPass,
  runLoginTypeSyncPass,
  runProfileSyncPass,
  runPromotionSyncPass,
  runPurchaseElementSyncPass,
  runPurchaseSyncPass,
  runReceiptSyncPass,
  runScheduleSyncPass,
  runServiceCategorySyncPass,
  runServiceSyncPass,
  runShopCategorySyncPass,
  runStaffSyncPass,
} from './pass.js';

/**
 * The scheduled jobs, as the board names them (PRD M09).
 *
 * WHY GROUPS AND NOT ONE PASS PER CRON. There are sixteen passes and six jobs.
 * "Catalogue sync" is not one pass - it is locations, shop categories,
 * promotions, service categories and the service catalogue, which only mean
 * anything together. Naming the job after what a human asked for, and listing
 * the passes underneath, keeps the schedule readable and stops a cron entry
 * quietly meaning something different from its name.
 *
 * ORDER INSIDE A GROUP IS THE DEPENDENCY ORDER, not alphabetical. The catalogue
 * ends with the service list because that pass upserts authoritative titles over
 * the stubs the purchase writer left; running it first would write the stub over
 * the real thing.
 *
 * ORDER BETWEEN GROUPS IS THE CLOCK. The schedule window runs at 01:00 and the
 * catalogue at 02:00 so sessions reference services that are already current -
 * that hour is the whole reason the two are separate jobs rather than one.
 *
 * A JOB THAT OVERLAPS ITSELF STANDS DOWN, not because this file says so but
 * because every pass takes its job's lease (migration 0035). Two groups that
 * share a pass therefore cannot both run it: the second one skips that pass and
 * carries on with the rest.
 */

export interface JobGroup {
  /** What the schedule calls it. This is the `?job=` value. */
  readonly name: string;
  /** One line, for the route's own listing and for an operator reading a log. */
  readonly summary: string;
  /**
   * How often this job is scheduled, in hours. The overdue alert compares it
   * against the last clean run - see src/notify/overdue.ts.
   *
   * Declared HERE and not parsed out of vercel.json: the schedule is deployment
   * configuration and nothing at runtime can read it, so inferring it would be
   * guessing. Two places to keep in step, and a test that pins them together.
   */
  readonly expectedEveryHours: number;
  /** Passes, in dependency order. */
  readonly passes: ReadonlyArray<{
    readonly job: string;
    readonly run: (config: AppConfig, deps: SyncPassDeps) => Promise<SyncPassSummary>;
  }>;
}

export const JOB_GROUPS: readonly JobGroup[] = [
  {
    name: 'schedule-window',
    expectedEveryHours: 24,
    summary: 'The class/appointment schedule for the current window. Runs BEFORE the catalogue.',
    passes: [{ job: 'schedule_sync', run: runScheduleSyncPass }],
  },
  {
    name: 'catalogue',
    expectedEveryHours: 24,
    summary: 'Locations, shop categories, promotions, service categories, services.',
    passes: [
      { job: 'location_sync', run: runLocationSyncPass },
      { job: 'shop_category_sync', run: runShopCategorySyncPass },
      { job: 'promotion_sync', run: runPromotionSyncPass },
      { job: 'service_category_sync', run: runServiceCategorySyncPass },
      // LAST: it writes the authoritative title over any purchase-derived stub.
      { job: 'service_sync', run: runServiceSyncPass },
    ],
  },
  {
    name: 'clients',
    expectedEveryHours: 24,
    summary: 'Every client WellnessLiving lists, and the GoHighLevel match for new ones.',
    passes: [
      // The login types first: the teacher view joins on is_teacher_type, so
      // without them nobody is a teacher however well everything else synced.
      { job: 'login_type_sync', run: runLoginTypeSyncPass },
      { job: 'client_list_sync', run: runClientListSyncPass },
      { job: 'profile_sync', run: runProfileSyncPass },
      { job: 'ghl_match_sync', run: runGhlMatchSyncPass },
    ],
  },
  {
    name: 'teachers',
    expectedEveryHours: 24,
    summary: 'Staff, their teaching flags and services.',
    passes: [{ job: 'staff_sync', run: runStaffSyncPass }],
  },
  {
    name: 'attendance-close',
    expectedEveryHours: 24,
    summary: 'Who actually turned up, for sessions that have ended.',
    passes: [
      { job: 'client_session_sync', run: runClientSessionSyncPass },
      { job: 'attendance_sync', run: runAttendanceSyncPass },
    ],
  },
  {
    name: 'purchases',
    expectedEveryHours: 24,
    summary: 'Purchases, their receipts, and the per-item detail.',
    passes: [
      { job: 'purchase_sync', run: runPurchaseSyncPass },
      { job: 'receipt_sync', run: runReceiptSyncPass },
      { job: 'purchase_element_sync', run: runPurchaseElementSyncPass },
    ],
  },
];

export function findJobGroup(name: string): JobGroup | undefined {
  return JOB_GROUPS.find((g) => g.name === name);
}

export interface JobGroupResult {
  readonly group: string;
  readonly passes: ReadonlyArray<{ job: string; summary: SyncPassSummary }>;
  /** failed if any pass failed; partial if any is unfinished; skipped if ALL skipped. */
  readonly state: 'ok' | 'partial' | 'failed' | 'skipped';
}

/**
 * Runs one group's passes in order, within a shared budget.
 *
 * ONE PASS FAILING DOES NOT STOP THE OTHERS. A pass reports failure as an
 * outcome rather than throwing (runPass converts what it can), and this loop
 * catches whatever still escapes - a pass that dies unexpectedly must not take
 * the rest of the group with it. Measured on 31 Aug 2026: attendance_sync failed
 * and the two passes after it ran fine, which is the behaviour being kept.
 */
export async function runJobGroup(
  group: JobGroup,
  config: AppConfig,
  deps: SyncPassDeps & { budgetMs?: number },
  now: () => number = () => Date.now(),
): Promise<JobGroupResult> {
  const startedAt = now();
  const total = deps.budgetMs ?? Number.POSITIVE_INFINITY;
  const passes: Array<{ job: string; summary: SyncPassSummary }> = [];

  for (const { job, run } of group.passes) {
    const remaining = total - (now() - startedAt);
    // Below this a pass would seed and immediately stop, which costs WL calls
    // and achieves nothing.
    if (remaining <= 0) break;
    try {
      passes.push({
        job,
        summary: await run(config, {
          ...deps,
          ...(Number.isFinite(remaining) ? { budgetMs: remaining } : {}),
        }),
      });
    } catch (error) {
      passes.push({
        job,
        summary: {
          runId: 'none',
          state: 'failed',
          claimed: 0,
          done: 0,
          requeued: 0,
          dead: 0,
          itemsRemaining: 0,
          error: error instanceof Error ? error.name : 'unknown error',
        },
      });
    }
  }

  const states = passes.map((p) => p.summary.state);
  // All skipped means the whole group is already running elsewhere - not a
  // failure, and worth saying distinctly so a scheduler does not retry it.
  const state: JobGroupResult['state'] = states.includes('failed')
    ? 'failed'
    : states.length > 0 && states.every((s) => s === 'skipped')
      ? 'skipped'
      : states.includes('partial') || passes.length < group.passes.length
        ? 'partial'
        : 'ok';

  return { group: group.name, passes, state };
}
