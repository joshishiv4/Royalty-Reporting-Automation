import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import { transactionReportStep, type TransactionStepDeps } from '../src/sync/pass.js';
import { readReportBuildPage, transactionReportSpec } from '../src/wl/report.js';

/**
 * The transaction report state machine.
 *
 * Three things here cannot be verified any other way, and all three were found
 * by measuring the live endpoint on 17 Sep 2026:
 *
 * 1. A QUEUED BUILD RETURNS ROWS on these reports - fifty of them, from the
 *    previous build - where the client-list report returns an empty list. So
 *    "the response has rows" is evidence of nothing, and a reader that trusted
 *    it would store last week's money as this week's and report a clean run.
 *
 * 2. THE WINDOW MUST BE FROZEN. WL caches a build by its filter and
 *    `is_refresh: 1` resets one in flight, so a window recomputed on each
 *    polling invocation restarts the build and the poll never converges.
 *
 * 3. PAGE READING MUST RESUME. Eleven pages of the payment view take ~95
 *    seconds against a 60-second function, so a loop that assumed it could
 *    finish would never finish once.
 */

const K = '334942';
/**
 * Every field id the item view sync maps. It has to be the complete list:
 * writeTransactionPage refuses a page that has lost one, because report columns
 * are configured in the WL portal and a removed column would otherwise stop
 * being written with no error at all.
 */
const ITEM_FIELDS = [
  'k_pay_transaction',
  'k_purchase',
  'k_purchase_item',
  'k_id',
  'id_table',
  'id_purchase_item',
  'k_promotion',
  'o_date.dtu_date',
  'o_date.dtl_date',
  'o_client.uid_client',
  'o_location.k_location',
  'text_revenue_category',
  'i_quantity',
  'm_amount',
  'm_sale',
  'm_net_sale',
  'm_discount_amount',
  'm_total_tax',
  'm_total_tip',
  'm_total_amount',
  'm_total_paid',
  'm_total_receipt',
  'm_debit',
  'm_credit',
  'm_account_change',
  'm_transaction_balance',
  'text_discount_code',
  'text_payment_method',
  'text_payment_method_base',
  'text_origin',
  'text_frequency',
  's_batch_number',
  'id_pay_transaction_status',
  'id_currency',
  'o_actor.uid_actor',
  'o_actor.text_actor',
  'o_action.is_refund_transaction',
  'o_purchase_item_title_link.a_item',
];

/** One row, distinct per index so a thousand of them are a thousand rows. */
function row(i: number): unknown[] {
  return ITEM_FIELDS.map((f) => {
    if (f === 'k_purchase_item') return String(190119840 + i);
    if (f === 'o_date.dtu_date') return '2025-10-01 06:17:22';
    if (f === 'o_date.dtl_date') return '2025-10-01 02:17:22';
    if (f === 'o_client.uid_client') return '36453766';
    if (f === 'o_location.k_location') return '244238';
    if (f === 'm_amount') return '239.00';
    if (f === 'i_quantity') return 1;
    if (f === 'o_action.is_refund_transaction') return false;
    if (f === 'o_purchase_item_title_link.a_item') return [{ text_title: 'Monthly Subscription' }];
    return null;
  });
}

interface HarnessOptions {
  /** What WL reports as the build status, per call. */
  readonly status: () => number;
  /** Rows to answer a page request with, given the offset. */
  readonly rowsAt?: (offset: number) => unknown[][];
  readonly lastCleanCompletionAt?: string | null;
  readonly pageSize?: number;
}

function harness(options: HarnessOptions) {
  let jobState: Record<string, unknown> = {
    last_clean_completion_at: options.lastCleanCompletionAt ?? null,
  };
  const bodies: Array<Record<string, unknown>> = [];
  const writes: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [];

  const wl = {
    request: vi.fn((_path: string, opts: { json?: Record<string, unknown> } = {}) => {
      const body = opts.json ?? {};
      bodies.push(body);
      const offset = Number(body.i_offset ?? 0);
      const status = options.status();
      return Promise.resolve({
        body: {
          a_field: ITEM_FIELDS,
          // ROWS EVEN WHILE BUILDING - the live behaviour being defended against.
          a_row: (options.rowsAt ?? (() => [row(0)]))(offset),
          id_report_status: status,
          dtu_complete: status === 3 ? '2026-09-17 09:21:51' : null,
          s_report: 'hash-of-the-filter',
          text_error: '',
        },
        traceId: 't',
        kLog: null,
        httpStatus: 200,
        latencyMs: 1,
      });
    }),
  };

  const db = {
    select: vi.fn((table: string) => Promise.resolve(table === 'sync_job_state' ? [jobState] : [])),
    upsert: vi.fn((table: string, rows: Array<Record<string, unknown>>) => {
      if (table === 'sync_job_state') jobState = { ...jobState, ...rows[0] };
      else writes.push({ table, rows });
      return Promise.resolve(rows);
    }),
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-1' }] : rows),
    ),
  } as unknown as SupabaseClient;

  const step = (nowIso: () => string, over: Partial<TransactionStepDeps> = {}) =>
    transactionReportStep({
      wl: wl as unknown as TransactionStepDeps['wl'],
      db,
      kBusiness: K,
      runId: 'r1',
      nowIso,
      priorAttempt: 0,
      jobName: 'tx_item_sync',
      report: 'item',
      cid: 739,
      historyStart: '1980-01-01',
      lookbackDays: 3,
      pageBudgetMs: 25_000,
      ...over,
    });

  return { step, bodies, writes, jobState: () => jobState };
}

const iso = (s: string) => () => s;

describe('requesting the build', () => {
  it('asks for 1980 to today on the first run, at i_limit 1000, and freezes the window', async () => {
    const h = harness({ status: () => 2 });
    const outcome = await h.step(iso('2026-09-17T09:00:00.000Z'));

    expect(h.bodies).toHaveLength(1);
    const body = h.bodies[0]!;
    expect(body.cid_report).toBe(739);
    expect(body.i_limit).toBe(1000);
    expect(body.is_refresh).toBe(1);
    expect(body.json_filter).toEqual({
      o_date: { dl_start: '1980-01-01', dl_end: '2026-09-17' },
    });
    // Frozen BEFORE any poll: a crash now resumes into the same build.
    expect(h.jobState().last_key).toBe('1980-01-01|2026-09-17');
    expect(h.jobState().report_handle).toBe('hash-of-the-filter');
    expect(h.jobState().page_number).toBe(0);
    expect(outcome).toEqual({ kind: 'defer', requeueAfterMs: 5_000 });
  });

  it('narrows to the daily overlap after a clean drain', async () => {
    const h = harness({ status: () => 2, lastCleanCompletionAt: '2026-09-16T04:00:00.000Z' });
    await h.step(iso('2026-09-17T09:00:00.000Z'));
    expect(h.bodies[0]!.json_filter).toEqual({
      o_date: { dl_start: '2026-09-14', dl_end: '2026-09-17' },
    });
  });
});

describe('polling', () => {
  /**
   * THE CACHE-KEY RULE, at the moment it actually bites: a build requested
   * before midnight and polled after it. Recompute the window and `dl_end` is
   * now tomorrow - a different filter, so WL starts a fresh build, the poll
   * never finds a finished one, and the pass defers forever while reporting
   * nothing wrong. Three minutes apart, so the hard deadline is not what is
   * being tested here.
   */
  it('polls the FROZEN window even after the clock has crossed its end date', async () => {
    const h = harness({ status: () => 2 });
    await h.step(iso('2026-09-17T23:59:00.000Z'));
    await h.step(iso('2026-09-18T00:02:00.000Z'));

    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]!.json_filter).toEqual(h.bodies[0]!.json_filter);
    // And it never refreshes again - that would reset the build in flight.
    expect(h.bodies[1]!.is_refresh).toBe(0);
  });

  it('backs off on each attempt instead of sleeping in the worker', async () => {
    const h = harness({ status: () => 2 });
    await h.step(iso('2026-09-17T09:00:00.000Z'));
    expect(await h.step(iso('2026-09-17T09:00:05.000Z'))).toEqual({
      kind: 'defer',
      requeueAfterMs: 10_000,
    });
    expect(await h.step(iso('2026-09-17T09:00:15.000Z'))).toEqual({
      kind: 'defer',
      requeueAfterMs: 20_000,
    });
  });

  /**
   * THE MEASURED TRAP. Status 2 with fifty rows attached is what the live
   * endpoint answers while building. Nothing may be written from it.
   */
  it('writes nothing while the build is queued, however many rows it returns', async () => {
    const h = harness({
      status: () => 2,
      rowsAt: () => Array.from({ length: 50 }, (_, i) => row(i)),
    });
    await h.step(iso('2026-09-17T09:00:00.000Z'));
    await h.step(iso('2026-09-17T09:00:05.000Z'));
    expect(h.writes).toHaveLength(0);
  });

  it('abandons a build past its deadline and restarts cleanly', async () => {
    const h = harness({ status: () => 2 });
    await h.step(iso('2026-09-17T09:00:00.000Z'));
    const outcome = await h.step(iso('2026-09-17T09:11:00.000Z'));
    expect(outcome).toEqual({ kind: 'defer', requeueAfterMs: 2_000 });
    expect(h.jobState().report_handle).toBeNull();
    expect(h.jobState().last_key).toBeNull();
  });
});

describe('reading pages', () => {
  it('writes the rows and clears the cursor when a short page ends the report', async () => {
    let status = 2;
    const h = harness({ status: () => status, rowsAt: () => [row(0)] });
    await h.step(iso('2026-09-17T09:00:00.000Z'));
    status = 3;
    const outcome = await h.step(iso('2026-09-17T09:00:10.000Z'));

    expect(outcome).toEqual({ kind: 'done' });
    expect(h.writes.map((w) => w.table)).toContain('pay_transaction_item');
    expect(h.jobState().report_handle).toBeNull();
    expect(h.jobState().page_number).toBe(0);
  });

  /**
   * Eleven full pages outlast the function, so the loop has to stop on a budget
   * and the next invocation has to continue where it stopped - not start over,
   * which would re-read the whole report every night and never reach the end.
   */
  it('stops on its page budget and resumes at the saved offset', async () => {
    const full = (): unknown[][] => Array.from({ length: 1000 }, (_, i) => row(i));
    let now = Date.parse('2026-09-17T09:00:00.000Z');
    const clock = () => new Date(now).toISOString();
    let status = 2;
    const h = harness({ status: () => status, rowsAt: full });

    await h.step(clock);
    status = 3;
    // A page budget of 0 makes the loop hand over after the first page.
    now += 10_000;
    const first = await h.step(clock, { pageBudgetMs: 0 });
    expect(first).toEqual({ kind: 'defer', requeueAfterMs: 1_000 });
    expect(h.jobState().page_number).toBe(1000);

    now += 1_000;
    await h.step(clock, { pageBudgetMs: 0 });
    // The poll precedes each read, so the last body is the page request - and it
    // asked for the offset the previous invocation saved.
    const pageRequests = h.bodies.filter((b) => Number(b.i_offset) > 0);
    expect(pageRequests.at(-1)!.i_offset).toBe(1000);
    expect(h.jobState().page_number).toBe(2000);
  });

  /**
   * The offset advances by the page SIZE, not by the row count. Advancing by a
   * short page's row count would leave the cursor mid-page and re-read rows that
   * were already stored - harmless for an upsert, but it would also never
   * terminate.
   */
  it('advances by the page size so a full page always lands on a page boundary', async () => {
    const full = (): unknown[][] => Array.from({ length: 1000 }, (_, i) => row(i));
    let status = 2;
    const h = harness({ status: () => status, rowsAt: full });
    await h.step(iso('2026-09-17T09:00:00.000Z'));
    status = 3;
    await h.step(iso('2026-09-17T09:00:10.000Z'), { pageBudgetMs: 0 });
    expect(h.jobState().page_number).toBe(1000);
  });
});

/**
 * The page read has its own guard, and it needs its own test: in the flow above
 * the poll always answers first, so a step-level test never reaches a page read
 * against an unfinished build. That gap is real, not theoretical - WL restarts a
 * build when anyone re-runs the report, including from the portal, so a report
 * that was complete when polled can be generating again a second later. Its
 * queued response carries the PREVIOUS build's rows.
 *
 * Proven by mutation: relaxing the check in readReportBuildPage to accept
 * anything that has not failed left all nine tests above green.
 */
describe('readReportBuildPage', () => {
  function wlAnswering(status: number) {
    return {
      request: vi.fn(() =>
        Promise.resolve({
          body: {
            a_field: ITEM_FIELDS,
            a_row: [row(0)],
            id_report_status: status,
            dtu_complete: status === 3 ? '2026-09-17 09:21:51' : null,
            s_report: 'hash-of-the-filter',
            text_error: '',
          },
          traceId: 't',
          kLog: null,
          httpStatus: 200,
          latencyMs: 1,
        }),
      ),
    };
  }

  const spec = transactionReportSpec(739, { dlStart: '1980-01-01', dlEnd: '2026-09-17' });

  it('refuses rows from a build that is generating again', async () => {
    const wl = wlAnswering(2) as unknown as TransactionStepDeps['wl'];
    await expect(readReportBuildPage(wl, K, spec, 0)).rejects.toThrow(/unfinished report/);
  });

  it('returns the page once the build is complete', async () => {
    const wl = wlAnswering(3) as unknown as TransactionStepDeps['wl'];
    const page = await readReportBuildPage(wl, K, spec, 0);
    expect(page.rows).toHaveLength(1);
  });
});
