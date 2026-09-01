import { readWindowRequest } from '../src/sync/visit-window.js';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import { closeJobState, setWindowOverride } from '../src/sync/job-state.js';

/**
 * A one-shot manual window is consumed by a CLEAN drain, and by nothing else.
 *
 * Clearing it when it is READ would lose the request the first time a run died
 * before doing the work - accepted, then silently forgotten. Clearing it on
 * `partial` would be worse: partial is the NORMAL ending here (a Vercel function
 * is capped at 60s while a sync is budgeted in hours), so the override would
 * evaporate before it had been honoured even once.
 */

const NOW = '2026-08-31T04:00:00.000Z';

function spy() {
  const upserts: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [];
  const db = {
    upsert: vi.fn((table: string, rows: Array<Record<string, unknown>>) => {
      upserts.push({ table, rows });
      return Promise.resolve(rows);
    }),
    select: vi.fn(() => Promise.resolve([])),
    // enqueue writes through a Postgres function now (migration 0032), so a
    // fake db has to answer it. It reports everything as inserted: these
    // tests are about what gets queued, not how Postgres resolves a clash.
    rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
    insert: vi.fn(() => Promise.resolve([])),
    update: vi.fn((table: string) =>
      Promise.resolve(table === 'sync_job_state' ? [{ job_name: 'j' }] : []),
    ),
  } as unknown as SupabaseClient;
  return { db, upserts };
}

const written = (upserts: Array<{ rows: Array<Record<string, unknown>> }>) => upserts[0]?.rows[0];

describe('a clean drain consumes the override', () => {
  it('clears both boundaries on ok', async () => {
    const { db, upserts } = spy();
    await closeJobState(db, 'client_session_sync', '111111', NOW, 'ok');
    const row = written(upserts);
    expect(row?.window_start_override).toBeNull();
    expect(row?.window_end_override).toBeNull();
    expect(row?.last_clean_completion_at).toBe(NOW);
  });

  it('leaves it alone on partial - the normal way a long run ends', async () => {
    const { db, upserts } = spy();
    await closeJobState(db, 'client_session_sync', '111111', NOW, 'partial');
    const row = written(upserts);
    expect(row).not.toHaveProperty('window_start_override');
    expect(row).not.toHaveProperty('last_clean_completion_at');
  });

  it('leaves it alone on failed, so the request survives to be retried', async () => {
    const { db, upserts } = spy();
    await closeJobState(db, 'client_session_sync', '111111', NOW, 'failed');
    const row = written(upserts);
    expect(row).not.toHaveProperty('window_end_override');
  });
});

describe('setting one', () => {
  it('upserts, so a job that has never run can still be given a window', async () => {
    const { db, upserts } = spy();
    await setWindowOverride(
      db,
      'client_session_sync',
      '111111',
      '2023-03-01T00:00:00.000Z',
      null,
      NOW,
    );
    const row = written(upserts);
    expect(upserts[0]?.table).toBe('sync_job_state');
    expect(row?.window_start_override).toBe('2023-03-01T00:00:00.000Z');
    expect(row?.window_end_override).toBeNull();
  });

  it('clears with two nulls rather than needing a second verb', async () => {
    const { db, upserts } = spy();
    await setWindowOverride(db, 'client_session_sync', '111111', null, null, NOW);
    const row = written(upserts);
    expect(row?.window_start_override).toBeNull();
    expect(row?.window_end_override).toBeNull();
  });

  it('never touches the watermark', async () => {
    // Setting a window is not a statement about what has been completed.
    const { db, upserts } = spy();
    await setWindowOverride(
      db,
      'client_session_sync',
      '111111',
      '2023-03-01T00:00:00.000Z',
      null,
      NOW,
    );
    expect(written(upserts)).not.toHaveProperty('last_clean_completion_at');
  });
});

/**
 * Triggering a dated backfill used to be two calls: set the window, then run.
 * That was a footgun - setting the window and forgetting to run left the
 * override sitting there for whichever cron fired next, which then quietly
 * re-read a range nobody had asked it for. The dates now ride on the trigger.
 */
describe('a start/end on the sync trigger sets the window for that run', () => {
  it('reads a plain date as the start of that day in UTC', () => {
    expect(readWindowRequest({ start: '2023-03-01' })).toEqual({
      start: '2023-03-01T00:00:00.000Z',
      end: null,
      requested: true,
    });
  });

  it('accepts a full ISO timestamp too', () => {
    expect(readWindowRequest({ end: '2023-03-31T18:30:00Z' }).end).toBe('2023-03-31T18:30:00.000Z');
  });

  // A cron sends no body. That must mean "use the derived rule", not "use an
  // empty window" - the difference is a nightly sync that reads nothing.
  it('reports NOT requested for an empty body', () => {
    expect(readWindowRequest({})).toEqual({ start: null, end: null, requested: false });
  });

  it('treats an empty string the same as absent', () => {
    expect(readWindowRequest({ start: '', end: '' }).requested).toBe(false);
  });

  /**
   * REFUSED, NOT COERCED. An unparseable date becomes `Invalid Date` and reaches
   * WellnessLiving as a window matching nothing - a request accepted, obeyed, and
   * worthless. Loud is the only safe failure.
   */
  it('refuses a date it cannot read rather than passing it on', () => {
    expect(() => readWindowRequest({ start: 'last tuesday' })).toThrow(/cannot read|not a date/);
  });

  it('refuses a non-string', () => {
    expect(() => readWindowRequest({ start: 20230301 })).toThrow(/must be a string/);
  });

  it('refuses an inverted range', () => {
    expect(() => readWindowRequest({ start: '2023-03-31', end: '2023-03-01' })).toThrow(
      /start must be before end/,
    );
  });

  // Equal boundaries are an empty window, which nobody means to ask for.
  it('refuses a zero-length range', () => {
    expect(() => readWindowRequest({ start: '2023-03-01', end: '2023-03-01' })).toThrow(
      /start must be before end/,
    );
  });
});
