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
    update: vi.fn(() => Promise.resolve([])),
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
