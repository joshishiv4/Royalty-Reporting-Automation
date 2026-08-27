import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import { WlRequestError } from '../src/wl/client.js';
import {
  claimBatch,
  enqueue,
  outcomeFromWlError,
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
      calls.push({ op: 'update', table, patch, query });
      return Promise.resolve(responses.update?.(table, patch, query) ?? []);
    }),
    insert: vi.fn((table: string, rows: unknown[]) => {
      calls.push({ op: 'insert', table, rows });
      return Promise.resolve(rows);
    }),
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
