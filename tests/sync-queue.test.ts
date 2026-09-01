import { describe, expect, it, vi } from 'vitest';
import { SupabaseError, type SupabaseClient } from '../src/supabase/client.js';
import { WlRequestError } from '../src/wl/client.js';
import {
  claimBatch,
  enqueue,
  outcomeFromError,
  outcomeFromWlError,
  SUPABASE_TRANSIENT_REQUEUE_MS,
  type QueueHandler,
  type QueueItem,
  runQueue,
  settle,
} from '../src/sync/queue.js';

const NOW = '2026-08-21T00:00:00.000Z';

interface Responses {
  select?: (table: string, query: string) => unknown[];
  update?: (table: string, patch: Record<string, unknown>, query: string) => unknown[];
}

function fakeDb(responses: Responses = {}) {
  const calls: Array<{
    op: string;
    table: string;
    patch?: Record<string, unknown>;
    query?: string;
    rows?: unknown[];
  }> = [];
  const db = {
    select: vi.fn((table: string, query: string) => {
      calls.push({ op: 'select', table, query });
      return Promise.resolve(responses.select?.(table, query) ?? []);
    }),
    update: vi.fn((table: string, patch: Record<string, unknown>, query: string) => {
      if (table === 'sync_job_state') return Promise.resolve([{ job_name: 'j' }]);
      calls.push({ op: 'update', table, patch, query });
      return Promise.resolve(responses.update?.(table, patch, query) ?? []);
    }),
    // enqueue writes through a Postgres function now (migration 0032), because
    // PostgREST cannot express ON CONFLICT DO NOTHING against a partial index.
    // Recorded as op 'insert' so the tests below still assert on the write
    // itself rather than on which client method happened to carry it.
    rpc: vi.fn((fn: string, args: { items: unknown[] }) => {
      calls.push({ op: 'insert', table: fn, rows: args.items });
      return Promise.resolve(args.items.length);
    }),
    insert: vi.fn((table: string, rows: unknown[]) => {
      calls.push({ op: 'insert', table, rows });
      return Promise.resolve(rows);
    }),
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
  return { db, calls };
}

const item: QueueItem = {
  id: 'q1',
  work_type: 'staff_list',
  target_key: 'all',
  k_business: '111111',
  attempt_count: 0,
};

function wlError(requeueAfterMs: number | null): WlRequestError {
  return new WlRequestError('transient', 'throttled', {
    path: '/v1/staff/list',
    sid: 'rate-limit',
    sField: null,
    traceId: 't.1',
    kLog: null,
    httpStatus: 200,
    latencyMs: 5,
    retryAfterMs: null,
    attempts: 4,
    requeueAfterMs,
  });
}

describe('outcomeFromWlError', () => {
  it('requeues when the client still has guidance', () => {
    const outcome = outcomeFromWlError(wlError(60_000));
    expect(outcome.kind).toBe('requeue');
    if (outcome.kind === 'requeue') {
      expect(outcome.requeueAfterMs).toBe(60_000);
      expect(outcome.failure.sid).toBe('rate-limit');
      expect(outcome.failure.traceId).toBe('t.1');
    }
  });

  it('dead-letters when requeue guidance is null (spent or permanent)', () => {
    expect(outcomeFromWlError(wlError(null)).kind).toBe('dead');
  });
});

describe('SupabaseError.isTransient', () => {
  const mk = (status: number | null) => new SupabaseError('purchase', status, 'x');
  it('treats a network failure or timeout (null status) as transient', () => {
    expect(mk(null).isTransient).toBe(true);
  });
  it('treats 429, 408 and any 5xx as transient', () => {
    expect(mk(429).isTransient).toBe(true);
    expect(mk(408).isTransient).toBe(true);
    expect(mk(500).isTransient).toBe(true);
    expect(mk(503).isTransient).toBe(true);
  });
  it('treats a 4xx (constraint, bad column) as NOT transient', () => {
    expect(mk(400).isTransient).toBe(false);
    expect(mk(404).isTransient).toBe(false);
    expect(mk(409).isTransient).toBe(false);
  });
});

describe('outcomeFromError', () => {
  it('delegates a WL error to the WL mapping', () => {
    const outcome = outcomeFromError(wlError(60_000));
    expect(outcome).not.toBeNull();
    expect(outcome?.kind).toBe('requeue');
    if (outcome?.kind === 'requeue') expect(outcome.requeueAfterMs).toBe(60_000);
  });

  // The bug this whole change fixes: a transient DB hiccup must requeue ONE item,
  // not escape the handler and abort the whole pass.
  it('requeues a transient SupabaseError instead of letting it throw', () => {
    const outcome = outcomeFromError(new SupabaseError('purchase', 503, 'unavailable'));
    expect(outcome?.kind).toBe('requeue');
    if (outcome?.kind === 'requeue') {
      expect(outcome.requeueAfterMs).toBe(SUPABASE_TRANSIENT_REQUEUE_MS);
      expect(outcome.failure.traceId).toBe('supabase:purchase');
      expect(outcome.failure.httpStatus).toBe(503);
    }
  });

  it('requeues a DB network failure (null status) too', () => {
    expect(outcomeFromError(new SupabaseError('purchase', null, 'TypeError'))?.kind).toBe(
      'requeue',
    );
  });

  // A real bug (constraint, bad column) must still surface, not be requeued
  // forever: outcomeFromError returns null so the caller rethrows.
  it('returns null for a non-transient SupabaseError, so the caller rethrows', () => {
    expect(outcomeFromError(new SupabaseError('purchase', 400, 'bad column'))).toBeNull();
  });

  it('returns null for an unrelated error', () => {
    expect(outcomeFromError(new Error('boom'))).toBeNull();
  });
});

describe('settle', () => {
  it('marks a done item done', async () => {
    const { db, calls } = fakeDb();
    await settle(db, item, { kind: 'done' }, NOW);
    expect(calls[0]).toMatchObject({ op: 'update', table: 'sync_queue', patch: { state: 'done' } });
    expect(calls[0]!.query).toContain('id=eq.q1');
  });

  it('requeues with next_attempt_at and advances attempt_count (decision 4)', async () => {
    const { db, calls } = fakeDb();
    await settle(db, item, outcomeFromWlError(wlError(60_000)), NOW);

    const patch = calls[0]!.patch as Record<string, unknown>;
    expect(patch.state).toBe('pending');
    // attempt_count 0 -> 1: the NEXT failure lands a rung further out.
    expect(patch.attempt_count).toBe(1);
    // next_attempt_at = now + the client's requeue delay.
    expect(patch.next_attempt_at).toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
    expect(patch.last_error_sid).toBe('rate-limit');
    // Lease is released so the item is cleanly claimable again.
    expect(patch.claim_expires_at).toBeNull();
  });

  it('dead-letters with the error recorded', async () => {
    const { db, calls } = fakeDb();
    await settle(db, item, outcomeFromWlError(wlError(null)), NOW);
    const patch = calls[0]!.patch as Record<string, unknown>;
    expect(patch.state).toBe('dead');
    expect(patch.last_error).toBe('throttled');
  });

  // Defer is waiting, not failing: back to pending on a delay, but NO error and
  // NO attempt_count bump - a slow report must never dead-letter itself.
  it('defers back to pending without an error or an attempt bump', async () => {
    const { db, calls } = fakeDb();
    await settle(db, item, { kind: 'defer', requeueAfterMs: 5_000 }, NOW);
    const patch = calls[0]!.patch as Record<string, unknown>;
    expect(patch.state).toBe('pending');
    expect(patch.next_attempt_at).toBe(new Date(Date.parse(NOW) + 5_000).toISOString());
    expect('attempt_count' in patch).toBe(false);
    expect('last_error' in patch).toBe(false);
    expect(patch.claim_expires_at).toBeNull();
  });
});

describe('claimBatch', () => {
  const opts = {
    now: NOW,
    workerId: 'run-1',
    limit: 5,
    leaseMs: 55_000,
    workTypes: ['staff_list'],
  };

  it('claims a candidate whose compare-and-swap wins', async () => {
    const { db } = fakeDb({
      select: () => [item],
      update: () => [item], // the conditional PATCH matched: we won the row
    });
    const claimed = await claimBatch(db, opts);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe('q1');
  });

  it('skips a candidate another worker already claimed (empty swap)', async () => {
    const { db } = fakeDb({
      select: () => [item],
      update: () => [], // conditional filter matched nothing: lost the race
    });
    expect(await claimBatch(db, opts)).toEqual([]);
  });

  it('claims only the requested work types - no cross-job theft', async () => {
    let claimQuery = '';
    const { db } = fakeDb({
      select: (_t, q) => {
        claimQuery = q;
        return [];
      },
    });
    await claimBatch(db, opts);
    expect(claimQuery).toContain('work_type=in.(staff_list)');
  });

  it('claims under a lease that expires after now', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { db } = fakeDb({
      select: () => [item],
      update: (_t, patch) => {
        seen.push(patch);
        return [item];
      },
    });
    await claimBatch(db, opts);
    expect(seen[0]!.claim_expires_at).toBe(new Date(Date.parse(NOW) + 55_000).toISOString());
    expect(seen[0]!.state).toBe('in_progress');
  });
});

describe('runQueue', () => {
  const opts = {
    now: NOW,
    workerId: 'run-1',
    limit: 5,
    leaseMs: 55_000,
    workTypes: ['staff_list'],
  };

  it('reclaims, claims, runs the handler and settles, counting outcomes', async () => {
    const { db, calls } = fakeDb({
      // reclaim update -> [], claim select -> [item], claim swap -> [item]
      update: (_t, _p, query) => (query.includes('claim_expires_at=lt') ? [] : [item]),
      select: () => [item],
    });
    const handler: QueueHandler = vi.fn((claimed: QueueItem) => {
      // The handler can read attempt_count to pass as priorAttempt (decision 4).
      expect(claimed.attempt_count).toBe(0);
      return Promise.resolve({ kind: 'done' as const });
    });

    const summary = await runQueue(db, handler, opts);

    expect(handler).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({ claimed: 1, done: 1, requeued: 0, dead: 0 });
    // Last write settles the item done.
    expect(calls.at(-1)).toMatchObject({ table: 'sync_queue', patch: { state: 'done' } });
  });
});

describe('enqueue', () => {
  it('skips a target that already has an active item', async () => {
    const { db, calls } = fakeDb({
      select: () => [{ work_type: 'staff_list', target_key: 'all', k_business: '111111' }],
    });
    const added = await enqueue(db, [
      { work_type: 'staff_list', target_key: 'all', k_business: '111111' },
    ]);
    expect(added).toBe(0);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('inserts a genuinely new target', async () => {
    const { db, calls } = fakeDb({ select: () => [] });
    const added = await enqueue(db, [
      { work_type: 'staff_list', target_key: 'all', k_business: '111111' },
    ]);
    expect(added).toBe(1);
    expect(calls.some((c) => c.op === 'insert')).toBe(true);
  });

  // Regression: the earlier draft dedupe-queried WITHOUT a work_type filter,
  // and did not paginate. Once the queue held more than PostgREST's 1000-row
  // cap of active items (measured 1,301 pending in receipt_sync alone during a
  // heavy backfill), the `seen` set silently missed rows and the follow-up
  // insert hit the (work_type, target_key, k_business WHERE active) unique
  // index. Every affected pass failed its whole seed with a SupabaseError.
  // The check must be BOTH scoped and paginated: scoping cuts noise, and
  // pagination is what makes it complete no matter how deep the queue is.
  it('scopes the active-item lookup by work_type and k_business', async () => {
    const { db, calls } = fakeDb({ select: () => [] });
    await enqueue(db, [
      { work_type: 'purchase_list', target_key: 'uid-1', k_business: '111111' },
      { work_type: 'purchase_list', target_key: 'uid-2', k_business: '111111' },
    ]);
    const selectCall = calls.find((c) => c.op === 'select');
    expect(selectCall).toBeDefined();
    const query = selectCall!.query ?? '';
    expect(query).toContain('work_type=in.(purchase_list)');
    expect(query).toContain('k_business=in.(111111)');
    expect(query).toContain('state=in.(pending,in_progress)');
  });

  it('pages past the PostgREST 1000-row cap so a deep queue does not slip rows', async () => {
    // A first page that fills the limit means "there might be more"; enqueue
    // must ask for a second page. Return a full page once, empty page after.
    let pages = 0;
    const firstPage = Array.from({ length: 1000 }, (_, i) => ({
      work_type: 'purchase_receipt',
      target_key: `existing-${String(i)}`,
      k_business: '111111',
    }));
    const { db, calls } = fakeDb({
      select: (_table, query) => {
        pages += 1;
        // The offset moves forward on the second call; on the third call the
        // second batch has been requested and we return empty.
        if (query.includes('offset=0')) return firstPage;
        return [];
      },
    });
    // The item we try to enqueue is one of the "existing" ones - it must be
    // deduped away by the SECOND page's contribution to `seen`, not skipped
    // because the first page was truncated.
    const added = await enqueue(db, [
      { work_type: 'purchase_receipt', target_key: 'existing-0', k_business: '111111' },
    ]);
    expect(added).toBe(0);
    expect(pages).toBeGreaterThanOrEqual(2);
    // Both offsets must actually be requested.
    expect(calls.some((c) => c.op === 'select' && (c.query ?? '').includes('offset=0'))).toBe(true);
    expect(calls.some((c) => c.op === 'select' && (c.query ?? '').includes('offset=1000'))).toBe(
      true,
    );
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  // Regression: an earlier draft only deduped against pending/in_progress rows,
  // so a target with a recent 'done' row was re-enqueued on every sync run.
  // Measured live: seven full-sync invocations in nine hours grew purchase_list
  // from 517 rows to 3,737, and client_visits from 517 to 5,307. The fresh-done
  // window makes a same-day re-invocation a no-op instead of a multiplier.
  it('skips a target with a recent done row within the fresh-done window', async () => {
    const NOW_MS = Date.parse('2026-08-27T10:00:00Z');
    const RECENT = new Date(NOW_MS - 60 * 60 * 1000).toISOString(); // 1h ago
    const { db, calls } = fakeDb({
      select: (_table, query) => {
        // active-item lookup: nothing pending or in-progress
        if (query.includes('state=in.(pending,in_progress)')) return [];
        // fresh-done lookup: one recent done row for the target
        if (query.includes('state=eq.done') && query.includes('updated_at=gte.')) {
          return [
            {
              work_type: 'purchase_list',
              target_key: 'uid-1',
              k_business: '111111',
              updated_at: RECENT,
            },
          ];
        }
        return [];
      },
    });
    const added = await enqueue(
      db,
      [{ work_type: 'purchase_list', target_key: 'uid-1', k_business: '111111' }],
      undefined,
      { now: () => NOW_MS },
    );
    expect(added).toBe(0);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('re-enqueues a target whose only done row is OLDER than the window', async () => {
    const NOW_MS = Date.parse('2026-08-27T10:00:00Z');
    const { db, calls } = fakeDb({
      // Both dedupe lookups return nothing - the old done row is not in the
      // window, and there is no active row either.
      select: () => [],
    });
    const added = await enqueue(
      db,
      [{ work_type: 'purchase_list', target_key: 'uid-1', k_business: '111111' }],
      undefined,
      { now: () => NOW_MS },
    );
    expect(added).toBe(1);
    expect(calls.some((c) => c.op === 'insert')).toBe(true);
  });

  it('honours forceReseed even when the target has a fresh done row', async () => {
    const NOW_MS = Date.parse('2026-08-27T10:00:00Z');
    const RECENT = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    let freshDoneQueried = false;
    const { db, calls } = fakeDb({
      select: (_table, query) => {
        if (query.includes('state=eq.done')) {
          freshDoneQueried = true;
          return [
            {
              work_type: 'ghl_contact_match',
              target_key: 'uid-1',
              k_business: '111111',
              updated_at: RECENT,
            },
          ];
        }
        return [];
      },
    });
    const added = await enqueue(
      db,
      [{ work_type: 'ghl_contact_match', target_key: 'uid-1', k_business: '111111' }],
      undefined,
      { now: () => NOW_MS, forceReseed: true },
    );
    // forceReseed skips the fresh-done query entirely - the retry MUST override
    // the "already synced" filter, otherwise a human-initiated re-check silently
    // does nothing for anyone matched within the last day.
    expect(freshDoneQueried).toBe(false);
    expect(added).toBe(1);
    expect(calls.some((c) => c.op === 'insert')).toBe(true);
  });

  it('scopes the fresh-done lookup by work_type and k_business, same as active', async () => {
    const NOW_MS = Date.parse('2026-08-27T10:00:00Z');
    const { db, calls } = fakeDb({ select: () => [] });
    await enqueue(
      db,
      [{ work_type: 'purchase_list', target_key: 'uid-1', k_business: '111111' }],
      undefined,
      { now: () => NOW_MS },
    );
    const done = calls.find((c) => c.op === 'select' && (c.query ?? '').includes('state=eq.done'));
    expect(done).toBeDefined();
    const q = done!.query ?? '';
    expect(q).toContain('work_type=in.(purchase_list)');
    expect(q).toContain('k_business=in.(111111)');
    expect(q).toContain('updated_at=gte.');
  });
});

/**
 * The 23505 that killed attendance_sync on 31 Aug 2026.
 *
 * enqueue dedupes with a READ and then inserts with a later WRITE, and nothing
 * holds between them. sync:full-parallel starts every pass at the same instant,
 * and a run that never closed can still be draining, so two runs of one pass
 * overlap easily: one moves rows pending->done while the other is paging the
 * dedupe read, that read skips rows, and the insert collides with the partial
 * unique index sync_queue_active_target_key.
 *
 * The dedupe stays - it saves sending tens of thousands of rows the database
 * would only discard - but it is no longer load-bearing for correctness.
 */
describe('enqueue cannot be broken by a racing run', () => {
  function harness(active: Array<Record<string, string>> = []) {
    const inserts: Array<{ method: string; rows: unknown[] }> = [];
    const db = {
      select: vi.fn((table: string, query: string) => {
        if (table === 'sync_queue' && query.includes('state=in.(pending,in_progress)')) {
          return Promise.resolve(query.includes('offset=0') ? active : []);
        }
        return Promise.resolve([]);
      }),
      insert: vi.fn((_t: string, rows: unknown[]) => {
        inserts.push({ method: 'insert', rows });
        return Promise.resolve(rows);
      }),
      // enqueue writes through a Postgres function now (migration 0032).
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => {
        inserts.push({ method: 'rpc', rows: args.items });
        return Promise.resolve(args.items.length);
      }),
    } as unknown as SupabaseClient;
    return { db, inserts };
  }

  const item = (target: string) => ({
    work_type: 'session_attendance',
    target_key: target,
    k_business: '111111',
  });

  // A plain INSERT fails the whole pass on one duplicate. ON CONFLICT DO
  // NOTHING - which is what insertIgnoringDuplicates emits - skips it, and a
  // duplicate here means the target already has an active item, which is
  // exactly the state the index exists to guarantee.
  it('writes through the atomic function, never a plain insert', async () => {
    const h = harness();
    await enqueue(h.db, [item('a'), item('b')]);

    // Nothing may reach a plain insert: that is the write that raised 23505.
    expect(h.inserts.map((i) => i.method)).toEqual(['rpc']);
  });

  // The dedupe read only knows what is stored. A caller handing the same target
  // in twice would collide with ITSELF inside a single insert, which no amount
  // of reading the database can prevent.
  it('dedupes the batch against itself, not just against the database', async () => {
    const h = harness();
    const added = await enqueue(h.db, [item('a'), item('a'), item('b')]);

    expect(h.inserts[0]?.rows).toHaveLength(2);
    expect(added).toBe(2);
  });

  // Reporting what we hoped to add would hide precisely the races worth seeing.
  it('reports what was actually inserted, not what was attempted', async () => {
    const db = {
      select: vi.fn(() => Promise.resolve([])),
      insert: vi.fn(() => Promise.resolve([])),
      // Two sent, ONE stored: the other lost the race and the database skipped
      // it. That gap is the whole reason this number is reported.
      rpc: vi.fn(() => Promise.resolve(1)),
    } as unknown as SupabaseClient;

    expect(await enqueue(db, [item('a'), item('b')])).toBe(1);
  });

  it('still skips a target the database already has active', async () => {
    const h = harness([{ work_type: 'session_attendance', target_key: 'a', k_business: '111111' }]);
    await enqueue(h.db, [item('a'), item('b')]);

    expect(h.inserts[0]?.rows).toHaveLength(1);
  });

  it('writes nothing at all when every target is already queued', async () => {
    const h = harness([{ work_type: 'session_attendance', target_key: 'a', k_business: '111111' }]);
    const added = await enqueue(h.db, [item('a')]);

    expect(h.inserts).toEqual([]);
    expect(added).toBe(0);
  });
});
