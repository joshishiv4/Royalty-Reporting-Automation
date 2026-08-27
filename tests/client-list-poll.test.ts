import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import { clientListReportStep, type ClientListStepDeps } from '../src/sync/pass.js';

/**
 * The client-list report is asynchronous, so its pass must poll ACROSS queue
 * invocations rather than sleep in one - a sleep loop burns the 60s function
 * budget and a slow build takes the run down with it. These drive one step at a
 * time and assert the state machine: request+save-before-poll, backoff while
 * building, resume from the saved handle, complete, and the hard-timeout restart.
 */

const K = '334942';
/**
 * Every field id this sync maps. It has to be all of them: writeClientList now
 * refuses a page whose field list has dropped one, because the report is
 * configured in the WL portal and a removed column would otherwise stop writing
 * that person column with no error (see assertReportFields). This fixture named
 * three, which is the exact state the guard rejects.
 */
const FIELDS = [
  'uid',
  'k_login_type',
  'field-general-2.text_name',
  'field-general-1',
  'field-general-3',
  'field-general-4',
  'field-general-5',
  'field-general-6',
  'field-general-7.dl_date',
  'field-general-11',
  'text_client_type',
];
const ROW = [
  '33793232',
  '1260510',
  'Jared',
  'Feldman',
  'jared@spindjacademy.com',
  '+15162720782',
  '',
  '',
  '1985-04-11',
  'MEM-4471',
  'Staff Client Profile',
];

/**
 * An in-memory sync_job_state so readReportState sees what the previous step
 * wrote, plus recorders for the WL calls and the person writes.
 */
function harness(reportStatus: () => number) {
  let jobState: Record<string, unknown> = {};
  const wlBodies: Array<Record<string, unknown>> = [];
  const upserts: Array<{ table: string; rows: unknown[] }> = [];

  const wl = {
    request: vi.fn((_path: string, opts: { json?: unknown } = {}) => {
      const body = opts.json as Record<string, unknown>;
      wlBodies.push(body);
      return Promise.resolve({
        body: { a_field: FIELDS, a_row: [ROW], id_report_status: reportStatus() },
        traceId: 't',
        kLog: null,
        httpStatus: 200,
        latencyMs: 1,
      });
    }),
  };

  const db = {
    select: vi.fn((table: string) =>
      Promise.resolve(
        table === 'sync_job_state' && jobState.report_handle !== undefined ? [jobState] : [],
      ),
    ),
    upsert: vi.fn((table: string, rows: Array<Record<string, unknown>>) => {
      if (table === 'sync_job_state') jobState = { ...jobState, ...rows[0] };
      else upserts.push({ table, rows });
      return Promise.resolve(rows);
    }),
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-1' }] : rows),
    ),
    // selectAll pages in production (PostgREST caps a read at 1,000 rows);
    // a fake answers in one call, so it shares the select handler.
    selectAll(table: string, query: string) {
      // `this` is cast because several of these literals are inferred as {}
      // before the outer `as unknown as SupabaseClient` is applied.
      return (this as { select: (t: string, q: string) => Promise<unknown[]> }).select(
        table,
        query,
      );
    },
  } as unknown as SupabaseClient;

  const step = (nowIso: () => string, priorAttempt = 0) =>
    clientListReportStep({
      wl: wl as unknown as ClientListStepDeps['wl'],
      db,
      kBusiness: K,
      runId: 'r1',
      nowIso,
      priorAttempt,
    });

  return { step, wlBodies, upserts, jobState: () => jobState };
}

const iso = (s: string) => () => s;

describe('client-list report state machine', () => {
  it('requests both builds and SAVES the handle before polling, then defers', async () => {
    const h = harness(() => 2); // still building
    const outcome = await h.step(iso('2026-08-27T00:00:00.000Z'));

    // First calls asked WL to build (is_refresh=1), one per filter - not a poll.
    expect(h.wlBodies).toHaveLength(2);
    expect(h.wlBodies.every((b) => b.is_refresh === 1)).toBe(true);
    // The handle was written (crash now -> resume into polling, not regenerate).
    expect(h.jobState().report_handle).toBe('2026-08-27T00:00:00.000Z');
    expect(h.jobState().report_handle_expires_at).toBeTruthy();
    // And it deferred on the first backoff rung, not a failure.
    expect(outcome).toEqual({ kind: 'defer', requeueAfterMs: 5_000 });
  });

  it('polls with is_refresh=0 while building and backs off 10s on the next attempt', async () => {
    const h = harness(() => 2);
    await h.step(iso('2026-08-27T00:00:00.000Z')); // request + save
    const outcome = await h.step(iso('2026-08-27T00:00:05.000Z')); // poll #1

    // The poll read the build - never restarted it.
    const polls = h.wlBodies.slice(2);
    expect(polls.every((b) => b.is_refresh === 0)).toBe(true);
    expect(outcome).toEqual({ kind: 'defer', requeueAfterMs: 10_000 });
  });

  it('resumes from the saved handle and completes when the build is ready', async () => {
    let status = 2;
    const h = harness(() => status);
    await h.step(iso('2026-08-27T00:00:00.000Z')); // request
    await h.step(iso('2026-08-27T00:00:05.000Z')); // poll, still building
    status = 3; // build finishes
    const outcome = await h.step(iso('2026-08-27T00:00:15.000Z')); // poll -> ready -> write

    expect(outcome).toEqual({ kind: 'done' });
    // People were written, tagged is_active from the activated set.
    const person = h.upserts.find((u) => u.table === 'person');
    expect(person).toBeDefined();
    expect((person!.rows[0] as Record<string, unknown>).is_active).toBe(true);
    // The handle is cleared so a later run starts fresh, not mid-poll.
    expect(h.jobState().report_handle).toBeNull();
  });

  it('abandons a build past its deadline and defers a clean restart', async () => {
    const h = harness(() => 2);
    await h.step(iso('2026-08-27T00:00:00.000Z')); // requested, expires +10min
    const outcome = await h.step(iso('2026-08-27T00:11:00.000Z')); // past the deadline

    expect(outcome).toEqual({ kind: 'defer', requeueAfterMs: 2_000 });
    expect(h.jobState().report_handle).toBeNull(); // cleared -> next step re-requests
  });
});
