import { describe, expect, it, vi } from 'vitest';
import {
  acquireJobLock,
  JOB_LEASE_MS,
  releaseJobLock,
  renewJobLock,
} from '../src/sync/job-state.js';
import type { SupabaseClient } from '../src/supabase/client.js';

/**
 * The job lease (migration 0035). This is not a hypothetical guard.
 *
 * sync_run on 31 Aug 2026:
 *   06:32:36  client_session_sync  running   (never closed - the process died)
 *   08:14:26  client_session_sync  ok        (a second run, while the first was
 *                                             still believed alive)
 *
 * The two overlapped: one drained rows pending -> done while the other paged
 * enqueue's dedupe read, so that read skipped rows and the insert collided with
 * `23505 ... sync_queue_active_target_key`. It killed attendance_sync and left
 * 32,440 items unqueued.
 */

const JOB = 'client_session_sync';
const BIZ = '111111';
const NOW = '2026-08-31T08:00:00.000Z';

/** Captures the query, which is where the whole locking rule lives. */
function db(rowsBack: unknown[] = [{ job_name: JOB }]) {
  const calls: Array<{ patch: Record<string, unknown>; query: string }> = [];
  const client = {
    update: vi.fn((_t: string, patch: Record<string, unknown>, query: string) => {
      calls.push({ patch, query });
      return Promise.resolve(rowsBack);
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('taking the lock is one conditional write, not a read then a write', () => {
  /**
   * Read-then-write cannot lock anything: two callers both read "free" and both
   * proceed, which IS the overlap. The condition has to travel with the write so
   * Postgres decides, and PostgREST tells us by how many rows it changed.
   */
  it('puts the free-or-expired condition in the query, not in our code', async () => {
    const h = db();
    await acquireJobLock(h.client, JOB, BIZ, 'run-1', NOW);

    const q = h.calls[0]?.query ?? '';
    expect(q).toContain(`job_name=eq.${JOB}`);
    expect(q).toContain(`k_business=eq.${BIZ}`);
    // Free, OR the previous holder's lease has run out.
    expect(q).toContain('or=(locked_until.is.null,locked_until.lt.');
  });

  it('reports success when the database changed a row', async () => {
    expect(await acquireJobLock(db().client, JOB, BIZ, 'run-1', NOW)).toBe(true);
  });

  // Zero rows changed means somebody else holds it. This is the whole point.
  it('reports FAILURE when the row was already locked', async () => {
    expect(await acquireJobLock(db([]).client, JOB, BIZ, 'run-1', NOW)).toBe(false);
  });

  it('stamps who holds it, so an overlap can name the culprit', async () => {
    const h = db();
    await acquireJobLock(h.client, JOB, BIZ, 'run-1', NOW);

    expect(h.calls[0]?.patch.locked_by).toBe('run-1');
  });

  /**
   * A LEASE, not a flag. `state = 'running'` already exists on this table and is
   * useless as a lock: the process that sets it is the only thing that clears
   * it, so a process that dies locks its job forever. Forty runs sat open on
   * live dev, the oldest ten days old.
   */
  it('sets an expiry in the future, so a died process cannot hold it forever', async () => {
    const h = db();
    await acquireJobLock(h.client, JOB, BIZ, 'run-1', NOW);

    const until = Date.parse(String(h.calls[0]?.patch.locked_until));
    expect(until).toBe(Date.parse(NOW) + JOB_LEASE_MS);
  });

  // Longer than any serverless invocation can live (60s on Vercel Hobby), so a
  // healthy run never loses its own lock mid-flight.
  it('leases for longer than a function can run', () => {
    expect(JOB_LEASE_MS).toBeGreaterThan(60_000);
  });
});

describe('renewing extends only our own lease', () => {
  /**
   * A CLI backfill runs for hours against a five-minute lease. Without renewal
   * it would let its own lock expire, the next scheduled run would take the job,
   * and the two would overlap - the same failure, arriving later.
   */
  it("scopes the renewal to the holder, so it cannot steal another run's lease", async () => {
    const h = db();
    await renewJobLock(h.client, JOB, BIZ, 'run-1', NOW);

    expect(h.calls[0]?.query).toContain('locked_by=eq.run-1');
  });

  it('pushes the expiry out', async () => {
    const h = db();
    await renewJobLock(h.client, JOB, BIZ, 'run-1', NOW);

    expect(Date.parse(String(h.calls[0]?.patch.locked_until))).toBe(Date.parse(NOW) + JOB_LEASE_MS);
  });

  // We were overtaken: our lease expired and somebody else took the job.
  it('reports failure when we no longer hold it', async () => {
    expect(await renewJobLock(db([]).client, JOB, BIZ, 'run-1', NOW)).toBe(false);
  });
});

describe('releasing is conditional too', () => {
  /**
   * A run that overran its lease has already been superseded. Releasing
   * unconditionally would unlock the job out from under whoever legitimately
   * took over, and the NEXT scheduled run would overlap with that one instead.
   * Better to leave a lease to expire than to clear somebody else's.
   */
  it('only clears a lock this run still holds', async () => {
    const h = db();
    await releaseJobLock(h.client, JOB, BIZ, 'run-1');

    expect(h.calls[0]?.query).toContain('locked_by=eq.run-1');
  });

  it('clears both columns, so the next run sees a free job', async () => {
    const h = db();
    await releaseJobLock(h.client, JOB, BIZ, 'run-1');

    expect(h.calls[0]?.patch).toEqual({ locked_until: null, locked_by: null });
  });
});
