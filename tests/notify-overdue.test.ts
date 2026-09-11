import { describe, expect, it, vi } from 'vitest';
import { buildDigest } from '../src/notify/failure-digest.js';
import { findOverdueJobs } from '../src/notify/overdue.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import { JOB_GROUPS } from '../src/sync/jobs.js';

/**
 * The overdue alert (PRD M10), and why it is the one that matters.
 *
 * A failure produces an error somebody can be told about. A job that never
 * STARTS produces nothing - no run row, no error, no signal at all. The data
 * stops moving while continuing to look completely plausible. Every other alert
 * in this system reads a record of something that happened; this one has to
 * notice the ABSENCE of one.
 */

const BIZ = '111111';
const NOW = Date.parse('2026-09-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** A sync_run table where every job last succeeded `h` hours ago. */
function db(h: number | null, queries: string[] = []) {
  return {
    queries,
    client: {
      select: vi.fn((_t: string, q: string) => {
        queries.push(q);
        return Promise.resolve(h === null ? [] : [{ finished_at: hoursAgo(h) }]);
      }),
    } as unknown as SupabaseClient,
  };
}

describe('a job that has not run is found by its absence', () => {
  it('reports nothing when every job ran recently', async () => {
    expect(await findOverdueJobs(db(2).client, BIZ, NOW)).toEqual([]);
  });

  // 24h cadence, 1.5x grace = 36h. A daily job checked just before its next run
  // is ~24h old and perfectly healthy; without slack every job would alert every
  // single day.
  it('allows a daily job to be a little late without crying wolf', async () => {
    expect(await findOverdueJobs(db(30).client, BIZ, NOW)).toEqual([]);
  });

  it('reports every job once it has missed a whole cycle', async () => {
    const out = await findOverdueJobs(db(40).client, BIZ, NOW);
    const passCount = JOB_GROUPS.reduce((n, g) => n + g.passes.length, 0);
    expect(out).toHaveLength(passCount);
  });

  /**
   * The case a subtraction-based check silently skips: there is no last run to
   * subtract from. A job that has NEVER succeeded is the most overdue thing
   * possible, and the easiest to miss.
   */
  it('reports a job that has never completed at all', async () => {
    const out = await findOverdueJobs(db(null).client, BIZ, NOW);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.hoursSince).toBeNull();
    expect(out[0]?.lastOkAt).toBeNull();
  });

  // A job failing every night is not "running fine". A failed run must not reset
  // the clock on the very alert that would surface it.
  it('only counts runs that finished cleanly', async () => {
    const h = db(2);
    await findOverdueJobs(h.client, BIZ, NOW);
    expect(h.queries[0]).toContain('state=eq.ok');
  });

  /**
   * One query per job, not one capped read of recent history. A job overdue by
   * three months has no row near the top of sync_run, so a capped read would
   * miss exactly the job worth alerting on.
   */
  it('asks about each job separately, so a long-dead one cannot hide', async () => {
    const h = db(2);
    await findOverdueJobs(h.client, BIZ, NOW);
    const passCount = JOB_GROUPS.reduce((n, g) => n + g.passes.length, 0);
    expect(h.queries).toHaveLength(passCount);
    for (const q of h.queries) expect(q).toContain('limit=1');
  });

  // Our own outage is not evidence about the jobs.
  it('says nothing when the read itself fails', async () => {
    const broken = {
      select: vi.fn(() => Promise.reject(new Error('down'))),
    } as unknown as SupabaseClient;
    expect(await findOverdueJobs(broken, BIZ, NOW)).toEqual([]);
  });
});

describe('the digest leads with what nothing else can report', () => {
  const overdue = [{ job: 'purchase_sync', expectedEveryHours: 24, hoursSince: 50 }];

  it('sends when a job is overdue even though nothing failed', () => {
    expect(buildDigest([], [], { overdue }).hasIssues).toBe(true);
  });

  // Overdue must not be buried behind a count of records that at least got as
  // far as being tried.
  it('puts the overdue count first in the subject', () => {
    const d = buildDigest([], [{ job_name: 'x_sync', error: 'boom' }], { overdue });
    expect(d.subject.indexOf('did not run')).toBeLessThan(d.subject.indexOf('crashed'));
  });

  it('explains in the body that no error would have been produced', () => {
    expect(buildDigest([], [], { overdue }).body).toContain('reports no error');
  });

  it('says plainly when a job has never completed', () => {
    const d = buildDigest([], [], {
      overdue: [{ job: 'purchase_sync', expectedEveryHours: 24, hoursSince: null }],
    });
    expect(d.body).toContain('never completed successfully');
  });
});

describe('records waiting on a human, and the parked backlog', () => {
  it('sends on a 48-hour review backlog with nothing else wrong', () => {
    const d = buildDigest([], [], {
      review: [{ issue: 'ghl_unresolved_48h', count: 201, oldest: '2026-08-21T10:42:17Z' }],
    });
    expect(d.hasIssues).toBe(true);
    // Plain English, not the column name - the reader has an inbox, not a schema.
    expect(d.body).toContain('unresolved for over 48 hours');
    expect(d.body).not.toContain('ghl_unresolved_48h');
  });

  it('names how long the oldest has been waiting', () => {
    const d = buildDigest([], [], {
      review: [{ issue: 'ambiguous_contact', count: 25, oldest: '2026-08-21T10:42:17Z' }],
    });
    expect(d.body).toContain('2026-08-21');
  });

  /**
   * A floor, because the per-run dead list already reports what died today.
   * Without one, a single stubborn record would be mailed as a "backlog" every
   * night until somebody deleted it - which is how an inbox stops being read.
   */
  it('ignores a handful of parked records', () => {
    expect(buildDigest([], [], { parkedTotal: 3 }).hasIssues).toBe(false);
  });

  it('reports a backlog once it is big enough to matter', () => {
    const d = buildDigest([], [], { parkedTotal: 400 });
    expect(d.hasIssues).toBe(true);
    expect(d.body).toContain('400');
  });

  // The whole point of the inbox staying worth reading.
  it('sends nothing at all when everything is clean', () => {
    expect(buildDigest([], [], { overdue: [], review: [], parkedTotal: 0 }).hasIssues).toBe(false);
  });
});
