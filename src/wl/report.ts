import type { WlClient, WlResponse } from './client.js';
import { WL_PATHS } from './endpoint.js';

/**
 * The reporting endpoint, and the two things about it that will bite anyone who
 * assumes it behaves like the rest of the API.
 *
 * IT IS ASYNCHRONOUS, AND IT LIES QUIETLY.
 * `/v1/report/query` answers `status: "ok"` immediately, with `a_row: []`, while
 * the report is still being built. Nothing in the body says "wait" unless you
 * look at `id_report_status`:
 *
 *     id_report_status 2  ->  queued. dtu_complete is null. The rows are
 *                             meaningless - NOT an empty result.
 *     id_report_status 3  ->  complete. dtu_complete is set. Zero rows now
 *                             genuinely means nobody matched.
 *
 * Measured 26 Aug 2026 against the live business: a filter matching nobody and a
 * filter matching 229 people BOTH returned 0 rows on the first call and differed
 * only on the second. Treating the first answer as final would have stored zero
 * clients and reported a clean run - the worst possible failure, because it
 * looks like success.
 *
 * WL caches by filter, so any change to json_filter starts a new report and the
 * first call for it is always queued.
 *
 * THE DATE FILTER IS MANDATORY AND IT SILENTLY EXCLUDES.
 * Omitting `o_date` is rejected outright (`end-date-not-set`), so there is no
 * "no date filter" option. And `id_report_date: 4` means CLIENT SINCE DATE, so
 * the window quietly drops anyone who joined outside it. Measured: a
 * 2010..2026 window returned 516 activated clients where the portal shows 517 -
 * one client, joined before 2010, missing with no error of any kind. The window
 * is therefore deliberately absurd (1900..2100): we want everyone, and the only
 * way to say "everyone" is to name a range nobody can fall outside.
 */

/** WL's "Client List" report. Named in the Postman collection as cid_report 689. */
export const REPORT_CLIENT_LIST = 689;

/**
 * "Everyone", expressed the only way this endpoint allows. See the header: a
 * narrower window drops clients without saying so.
 */
export const ALL_DATES = {
  /**
   * The studio's chosen floor, and older than the studio. `id_report_date: 4` is
   * CLIENT SINCE DATE, and a window that starts too late drops people with no
   * error at all: a 2010..2026 window returned 516 activated clients where the
   * portal showed 517 - one client, joined before 2010, simply absent.
   */
  dl_start: '1980-01-01',
  /**
   * FIXED, NOT `now` - and that is a deliberate refusal of the obvious.
   *
   * An end date of "today" changes every single day, and WL CACHES A REPORT BY
   * ITS FILTER. A moving end date therefore starts a fresh report build on every
   * run, so every run pays the full queue-and-poll wait instead of reading a
   * built one. Nobody has a join date in the future, so the two windows select
   * exactly the same clients - one of them just costs a rebuild each time.
   */
  dl_end: '2100-12-31',
  /** 4 = client since date. */
  id_report_date: 4,
} as const;

/** WL's member-status filter. 3 is what the portal calls "Activated Clients". */
export const MEMBER_STATUS_ACTIVATED = 3;

/** The report is complete and its rows can be trusted. */
const REPORT_STATUS_COMPLETE = 3;

/** WL's own page size for this report. */
export const REPORT_PAGE_SIZE = 500;

/** How long to wait between polls, and how many times to ask. */
const POLL_INTERVAL_MS = 1_500;
const MAX_POLLS = 40;

export interface ReportBody {
  readonly a_field?: unknown;
  readonly a_row?: unknown;
  readonly id_report_status?: unknown;
  readonly dtu_complete?: unknown;
}

export interface ReportPage {
  /** Column ids, in the order the values appear in each row. */
  readonly fields: readonly string[];
  /** One array of values per client. Positional - see mapClientRow. */
  readonly rows: ReadonlyArray<readonly unknown[]>;
  /** The last response, for raw_wl. */
  readonly response: WlResponse<ReportBody>;
}

export interface ReportFilter {
  /** Client type keys to include. Empty means every type. */
  readonly clientTypes?: readonly string[];
  /** Member statuses to include. Empty means every status. */
  readonly memberStatuses?: readonly number[];
}

/**
 * Builds the request body.
 *
 * Every `o_*` key is sent even when empty. WL rejects or misreads a partial
 * filter object, and the Postman collection sends the full set - so this mirrors
 * it exactly rather than trimming to what looks necessary.
 */
export function buildReportBody(
  kBusiness: string,
  filter: ReportFilter,
  offset: number,
  refresh: boolean,
): Record<string, unknown> {
  return {
    k_business: kBusiness,
    cid_report: REPORT_CLIENT_LIST,
    i_limit: REPORT_PAGE_SIZE,
    i_offset: offset,
    is_backend: 1,
    is_refresh: refresh ? 1 : 0,
    s_sort: 'uid',
    json_filter: {
      o_business_contract: [],
      o_client_churn_risk: [],
      o_client_type: filter.clientTypes ?? [],
      o_date: ALL_DATES,
      o_gender: [],
      o_liability_waiver: [],
      o_location_home: [],
      o_login_list: [],
      o_member_group: [],
      o_member_status: filter.memberStatuses ?? [],
      o_member_subscribe: [],
      o_promotion_special: [],
      o_search: '',
      o_search_template: { is_dashboard: 0, k_search_template: '' },
      o_user_app: [],
    },
  };
}

export interface ReportDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly deadline?: number;
  readonly priorAttempt?: number;
}

/**
 * Fetches one page, waiting for the report to finish building.
 *
 * Throws rather than returning a half-answer if the report never completes: a
 * timeout is a failure the queue should retry, whereas returning the queued
 * response would be indistinguishable from "this business has no clients".
 */
export async function fetchReportPage(
  wl: Pick<WlClient, 'request'>,
  kBusiness: string,
  filter: ReportFilter,
  offset: number,
  deps: ReportDeps = {},
): Promise<ReportPage> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    // Only the first call asks WL to rebuild; the rest read the report it is
    // already building. Asking again would restart it and never converge.
    const body = buildReportBody(kBusiness, filter, offset, poll === 0);
    const response = await wl.request<ReportBody>(WL_PATHS.reportQuery, {
      method: 'POST',
      json: body,
      ...(deps.deadline === undefined ? {} : { deadline: deps.deadline }),
      ...(deps.priorAttempt === undefined ? {} : { priorAttempt: deps.priorAttempt }),
    });

    if (readInt(response.body.id_report_status) === REPORT_STATUS_COMPLETE) {
      return {
        fields: readFields(response.body.a_field),
        rows: readRows(response.body.a_row),
        response,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `WL report ${String(REPORT_CLIENT_LIST)} did not finish building after ` +
      `${String(MAX_POLLS)} polls - refusing to treat a queued report as an empty one`,
  );
}

/**
 * Fetches every page.
 *
 * A short page ends the walk. WL has no total in this response, so there is
 * nothing to check the count against here - the caller reconciles.
 */
export async function fetchAllReportRows(
  wl: Pick<WlClient, 'request'>,
  kBusiness: string,
  filter: ReportFilter,
  deps: ReportDeps = {},
): Promise<{ fields: readonly string[]; pages: readonly ReportPage[]; rowCount: number }> {
  const pages: ReportPage[] = [];
  let offset = 0;
  let fields: readonly string[] = [];
  let rowCount = 0;

  for (;;) {
    const page = await fetchReportPage(wl, kBusiness, filter, offset, deps);
    if (fields.length === 0) fields = page.fields;
    pages.push(page);
    rowCount += page.rows.length;
    if (page.rows.length < REPORT_PAGE_SIZE) break;
    offset += REPORT_PAGE_SIZE;
  }

  return { fields, pages, rowCount };
}

/**
 * A single request against the report - no poll loop. This is the building block
 * of the NON-BLOCKING flow: a worker must not sit sleeping while a report builds
 * (that burns the 60s function budget for nothing), so the caller makes one call,
 * decides from `status`, and defers to a later invocation if it is not ready.
 */
async function reportRequestOnce(
  wl: Pick<WlClient, 'request'>,
  kBusiness: string,
  filter: ReportFilter,
  offset: number,
  refresh: boolean,
  deps: ReportDeps = {},
): Promise<{ status: number | null; page: ReportPage }> {
  const body = buildReportBody(kBusiness, filter, offset, refresh);
  const response = await wl.request<ReportBody>(WL_PATHS.reportQuery, {
    method: 'POST',
    json: body,
    ...(deps.deadline === undefined ? {} : { deadline: deps.deadline }),
    ...(deps.priorAttempt === undefined ? {} : { priorAttempt: deps.priorAttempt }),
  });
  return {
    status: readInt(response.body.id_report_status),
    page: {
      fields: readFields(response.body.a_field),
      rows: readRows(response.body.a_row),
      response,
    },
  };
}

/**
 * Asks WL to (re)build the report. `is_refresh: 1` starts a fresh build for this
 * filter - call it ONCE, before polling, and save that you did (the queue item's
 * job state) so a later poll reads the same build instead of restarting it.
 */
export async function requestReport(
  wl: Pick<WlClient, 'request'>,
  kBusiness: string,
  filter: ReportFilter,
  deps: ReportDeps = {},
): Promise<void> {
  await reportRequestOnce(wl, kBusiness, filter, 0, true, deps);
}

/**
 * One status check with `is_refresh: 0` - reads the build already in flight, never
 * restarts it. Returns whether it has finished; the caller defers and polls again
 * later if not.
 */
export async function pollReport(
  wl: Pick<WlClient, 'request'>,
  kBusiness: string,
  filter: ReportFilter,
  deps: ReportDeps = {},
): Promise<{ complete: boolean }> {
  const { status } = await reportRequestOnce(wl, kBusiness, filter, 0, false, deps);
  return { complete: status === REPORT_STATUS_COMPLETE };
}

/**
 * Reads every page of an ALREADY-COMPLETE report, `is_refresh: 0` throughout so it
 * never restarts the build. Fast (the rows exist); the slow part was the wait,
 * which the caller has already cleared by polling to completion.
 */
export async function readAllReportRows(
  wl: Pick<WlClient, 'request'>,
  kBusiness: string,
  filter: ReportFilter,
  deps: ReportDeps = {},
): Promise<{ fields: readonly string[]; pages: readonly ReportPage[]; rowCount: number }> {
  const pages: ReportPage[] = [];
  let offset = 0;
  let fields: readonly string[] = [];
  let rowCount = 0;
  for (;;) {
    const { page } = await reportRequestOnce(wl, kBusiness, filter, offset, false, deps);
    if (fields.length === 0) fields = page.fields;
    pages.push(page);
    rowCount += page.rows.length;
    if (page.rows.length < REPORT_PAGE_SIZE) break;
    offset += REPORT_PAGE_SIZE;
  }
  return { fields, pages, rowCount };
}

function readInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function readFields(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((f) => (typeof f === 'string' ? f : ''));
}

function readRows(value: unknown): ReadonlyArray<readonly unknown[]> {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is unknown[] => Array.isArray(r));
}
