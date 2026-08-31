import { describe, expect, it, vi } from 'vitest';
import { GhlRequestError, type GhlSearchResponse } from '../src/ghl/client.js';
import type { AppConfig } from '../src/config/schema.js';
import { recordingGhl, storeRawGhl } from '../src/sync/ghl-writer.js';
import { outcomeFromGhlError } from '../src/sync/queue.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import { runGhlMatchSyncPass } from '../src/sync/pass.js';

/**
 * PRD M06. Two properties, and the project got both wrong before this file:
 *
 *   1. GoHighLevel is SUPPLEMENTARY. WellnessLiving is the system of record, so
 *      an outage there must degrade to stale data, never a failed run. Measured
 *      live on dev before the fix: a dead GoHighLevel returned state 'failed'
 *      and stopped the drain loop, so a supplementary service could halt work
 *      that had nothing to do with it.
 *
 *   2. Every WellnessLiving response has been kept since migration 0008 - 2,534
 *      rows on dev - while raw_ghl sat at exactly zero, because nothing ever
 *      wrote to it. The matcher read a search, decided, and discarded the
 *      evidence.
 */

const K_BUSINESS = '111111';
const LOCATION = 'loc-1';
const config = {
  env: 'dev',
  wl: { kBusiness: K_BUSINESS },
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
  ghl: { locationId: LOCATION },
} as unknown as AppConfig;

const response = (over: Partial<GhlSearchResponse> = {}): GhlSearchResponse => ({
  contacts: [],
  total: 0,
  latencyMs: 12,
  httpStatus: 200,
  body: { contacts: [], traceId: 'ghl-trace-1', meta: { extra: 'kept' } },
  ghlTraceId: 'ghl-trace-1',
  requestParams: { locationId: LOCATION, pageLimit: 20, filters: [] },
  ...over,
});

const ghlError = (kind: 'transient' | 'auth' | 'permanent') =>
  new GhlRequestError(kind, `GoHighLevel is ${kind}`, {
    path: '/contacts/search',
    httpStatus: kind === 'auth' ? 401 : kind === 'permanent' ? 422 : 503,
    latencyMs: 5,
    retryAfterMs: null,
    attempts: 3,
  });

/** A pass harness with one queued person and a GoHighLevel that misbehaves. */
function harness(ghl: { searchContacts: () => Promise<GhlSearchResponse> }) {
  const inserts: Array<{ table: string; rows: unknown[] }> = [];
  const patches: Array<Record<string, unknown>> = [];
  const queueItem = {
    id: 'q1',
    work_type: 'ghl_contact_match',
    target_key: 'u1',
    k_business: K_BUSINESS,
    attempt_count: 0,
  };
  let claimed = false;

  const db = {
    insert: vi.fn((table: string, rows: unknown[]) => {
      inserts.push({ table, rows });
      return Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : [{ id: 'raw-1' }]);
    }),
    upsert: vi.fn((_t: string, rows: unknown[]) => Promise.resolve(rows)),
    update: vi.fn((table: string, patch: Record<string, unknown>, query?: string) => {
      if (table === 'person') patches.push(patch);
      if (table === 'sync_queue' && (query ?? '').includes('id=eq.') && !claimed) {
        claimed = true;
        return Promise.resolve([queueItem]);
      }
      return Promise.resolve([]);
    }),
    select: vi.fn((table: string, query: string) => {
      if (table === 'person' && query.includes('select=uid') && !query.includes('phone')) {
        return Promise.resolve([{ uid: 'u1' }]);
      }
      if (table === 'person' && query.includes('phone')) {
        return Promise.resolve([
          { uid: 'u1', phone: '+15550000000', email: null, ghl_unresolved_since: null },
        ]);
      }
      if (table === 'sync_queue' && query.includes('order=next_attempt_at.asc') && !claimed) {
        return Promise.resolve([queueItem]);
      }
      return Promise.resolve([]);
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

  return { db, ghl, inserts, patches };
}

const run = (h: ReturnType<typeof harness>) =>
  runGhlMatchSyncPass(config, { db: h.db, ghl: h.ghl, now: () => 0, budgetMs: 5_000 });

describe('a GoHighLevel outage does not take the run down', () => {
  /**
   * The headline criterion. Before the fix this came back 'failed': runQueue
   * does not catch a handler, so the throw reached runPass's outer catch and
   * ended the whole pass.
   */
  it('still reports a successful run when every search fails', async () => {
    const h = harness({ searchContacts: () => Promise.reject(ghlError('transient')) });
    const summary = await run(h);

    expect(summary.state).not.toBe('failed');
    expect(summary.error).toBeUndefined();
  });

  it('requeues the client rather than dead-lettering them', async () => {
    const h = harness({ searchContacts: () => Promise.reject(ghlError('transient')) });
    const summary = await run(h);

    expect(summary.requeued).toBe(1);
    expect(summary.dead).toBe(0);
  });

  // Stale data is the required degradation. Writing 'unmatched' because
  // GoHighLevel was down would turn an outage into a wrong answer, and the
  // 48-hour clock would start on a client who may well be perfectly linked.
  it('leaves the existing person record completely untouched', async () => {
    const h = harness({ searchContacts: () => Promise.reject(ghlError('transient')) });
    await run(h);

    expect(h.patches).toEqual([]);
  });

  it('stores no raw payload when there was no response to store', async () => {
    const h = harness({ searchContacts: () => Promise.reject(ghlError('transient')) });
    await run(h);

    expect(h.inserts.filter((i) => i.table === 'raw_ghl')).toEqual([]);
  });
});

describe('which GoHighLevel failures are worth retrying', () => {
  // A token blip must not dead-letter every client at once. The queue's own
  // attempt ladder decides when to give up, not the first bad response.
  it('retries an auth failure instead of giving up on the client', () => {
    expect(outcomeFromGhlError(ghlError('auth'), 1_000).kind).toBe('requeue');
  });

  // 'permanent' is about THIS request - a malformed filter, a 404. Retrying it
  // forever is noise, and the item should be visible as dead.
  it('dead-letters a permanent failure, which is about the request not the service', () => {
    expect(outcomeFromGhlError(ghlError('permanent'), 1_000).kind).toBe('dead');
  });

  it('carries the status and message through for whoever reads the queue', () => {
    const out = outcomeFromGhlError(ghlError('transient'), 1_000);
    expect(out.failure.httpStatus).toBe(503);
    expect(out.failure.message).toContain('transient');
    // GHL has no k_log and the sid is WL's; claiming otherwise would be a lie
    // in a column somebody quotes on a support ticket.
    expect(out.failure.kLog).toBeNull();
    expect(out.failure.sid).toBeNull();
  });
});

describe('every GoHighLevel response is kept', () => {
  it('stores a raw_ghl row for the search, even when it matched nobody', async () => {
    const h = harness({ searchContacts: () => Promise.resolve(response()) });
    await run(h);

    const raw = h.inserts.filter((i) => i.table === 'raw_ghl');
    expect(raw).toHaveLength(1);
  });

  // The matcher searches phone, then email only if phone found nothing. Both
  // calls are evidence; the recorder means the matcher never has to know.
  it('stores one row per search when the matcher falls through to email', async () => {
    let n = 0;
    const h = harness({
      searchContacts: () => {
        n += 1;
        return Promise.resolve(response());
      },
    });
    // phone then email: the fixture person has a phone, no email, so only one
    // search happens - assert on what the recorder saw rather than assuming.
    await run(h);
    expect(h.inserts.filter((i) => i.table === 'raw_ghl')).toHaveLength(n);
  });

  it('links the payload to the client it was fetched for', async () => {
    const h = harness({ searchContacts: () => Promise.resolve(response()) });
    await run(h);

    const row = h.inserts.find((i) => i.table === 'raw_ghl')?.rows[0] as Record<string, unknown>;
    expect(row.person_uid).toBe('u1');
  });

  /**
   * The whole body, not the typed contacts. mapContact drops any contact with
   * no id and keeps only six named fields.
   *
   * This is what made the enrichment cheap when it landed: migration 0026
   * backfilled 317 clients out of these stored payloads with no call to
   * GoHighLevel. Keeping the body is what preserved that choice.
   */
  it('keeps the response verbatim, including fields nothing reads yet', async () => {
    const h = harness({ searchContacts: () => Promise.resolve(response()) });
    await run(h);

    const row = h.inserts.find((i) => i.table === 'raw_ghl')?.rows[0] as Record<string, unknown>;
    expect(row.payload).toEqual({ contacts: [], traceId: 'ghl-trace-1', meta: { extra: 'kept' } });
  });

  it("records GoHighLevel's own trace id, which is what a support ticket quotes", async () => {
    const h = harness({ searchContacts: () => Promise.resolve(response()) });
    await run(h);

    const row = h.inserts.find((i) => i.table === 'raw_ghl')?.rows[0] as Record<string, unknown>;
    expect(row.ghl_trace_id).toBe('ghl-trace-1');
  });

  it('records what was asked, so a stored payload can be read without guessing', async () => {
    const h = harness({ searchContacts: () => Promise.resolve(response()) });
    await run(h);

    const row = h.inserts.find((i) => i.table === 'raw_ghl')?.rows[0] as Record<string, unknown>;
    expect(row.request_params).toEqual({ locationId: LOCATION, pageLimit: 20, filters: [] });
  });
});

describe('the recorder sits at the client boundary', () => {
  // Storing inside the matcher would mean every future caller has to remember.
  // Wrapping the client means it cannot be forgotten - the same reasoning that
  // puts the status assertion inside WlClient.request().
  it('hands the caller back exactly what the client returned', async () => {
    const original = response({ total: 3 });
    const seen: GhlSearchResponse[] = [];
    const wrapped = recordingGhl({ searchContacts: () => Promise.resolve(original) }, (r) =>
      seen.push(r),
    );

    const out = await wrapped.searchContacts({ phone: '+15550000000' });
    expect(out).toBe(original);
    expect(seen).toEqual([original]);
  });

  it('records nothing when the search rejects', async () => {
    const seen: GhlSearchResponse[] = [];
    const wrapped = recordingGhl(
      { searchContacts: () => Promise.reject(ghlError('transient')) },
      (r) => seen.push(r),
    );

    await expect(wrapped.searchContacts({ phone: '+1' })).rejects.toThrow('transient');
    expect(seen).toEqual([]);
  });
});

describe('storeRawGhl records the shape raw_ghl expects', () => {
  it("calls a search a 'page', because it is neither a record nor a cursor", async () => {
    const rows: unknown[] = [];
    const db = {
      insert: vi.fn((_t: string, r: unknown[]) => {
        rows.push(...r);
        return Promise.resolve(r);
      }),
    } as unknown as SupabaseClient;

    await storeRawGhl(db, {
      locationId: LOCATION,
      sourceEndpoint: '/contacts/search',
      response: response(),
      runId: 'run-1',
      personUid: 'u1',
    });

    const row = rows[0] as Record<string, unknown>;
    expect(row.target_kind).toBe('page');
    expect(row.location_id).toBe(LOCATION);
    expect(row.http_status).toBe(200);
    expect(row.latency_ms).toBe(12);
  });
});
