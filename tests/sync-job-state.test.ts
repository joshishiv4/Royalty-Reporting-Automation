import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import { closeJobState, openJobState } from '../src/sync/job-state.js';

const NOW = '2026-08-21T12:00:00.000Z';
const JOB = 'purchase_sync';
const KB = '111111';

function fakeDb() {
  const upserts: Array<{ rows: Record<string, unknown>[]; onConflict: string }> = [];
  const db = {
    upsert: vi.fn((_t: string, rows: Record<string, unknown>[], opts: { onConflict: string }) => {
      upserts.push({ rows, onConflict: opts.onConflict });
      return Promise.resolve(rows);
    }),
  } as unknown as SupabaseClient;
  return { db, upserts };
}

describe('openJobState', () => {
  it('marks the job running, keyed on job_name+k_business', async () => {
    const { db, upserts } = fakeDb();
    await openJobState(db, JOB, KB, NOW);
    expect(upserts[0]!.onConflict).toBe('job_name,k_business');
    expect(upserts[0]!.rows[0]).toEqual({
      job_name: JOB,
      k_business: KB,
      state: 'running',
      last_seen_at: NOW,
    });
  });
});

describe('closeJobState', () => {
  it('a clean pass goes idle and moves the watermark', async () => {
    const { db, upserts } = fakeDb();
    await closeJobState(db, JOB, KB, NOW, 'ok');
    expect(upserts[0]!.rows[0]).toMatchObject({
      state: 'idle',
      last_clean_completion_at: NOW,
    });
  });

  it('a partial pass pauses and does NOT touch the watermark', async () => {
    const { db, upserts } = fakeDb();
    await closeJobState(db, JOB, KB, NOW, 'partial');
    const row = upserts[0]!.rows[0]!;
    expect(row.state).toBe('paused');
    // The watermark column is absent, so an earlier clean completion survives.
    expect('last_clean_completion_at' in row).toBe(false);
  });

  it('a failed pass records failed and leaves the watermark alone', async () => {
    const { db, upserts } = fakeDb();
    await closeJobState(db, JOB, KB, NOW, 'failed');
    const row = upserts[0]!.rows[0]!;
    expect(row.state).toBe('failed');
    expect('last_clean_completion_at' in row).toBe(false);
  });
});
