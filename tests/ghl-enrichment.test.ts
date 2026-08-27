import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { GhlContact, GhlSearchResponse } from '../src/ghl/client.js';
import { GhlRequestError } from '../src/ghl/client.js';
import { contactSnapshot } from '../src/ghl/snapshot.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import { upsertGhlContact } from '../src/sync/ghl-writer.js';
import { runGhlMatchSyncPass } from '../src/sync/pass.js';

/**
 * PRD M06, second half: the agreed fields and tags on a client record.
 *
 * The three properties worth protecting here are all ones the obvious
 * implementation gets wrong:
 *
 *   1. ONE ROW PER CONTACT, NOT PER PERSON. 307 distinct contacts across 317
 *      matched clients (measured 26 Aug 2026) - a family on one phone number
 *      shares a contact. Enrichment stored per person would hold the same fact
 *      in several rows, which a partial run can leave disagreeing.
 *
 *   2. THE ENRICHMENT MUST NOT BE ABLE TO COST A SECOND SEARCH. A client is
 *      searched in GoHighLevel exactly once, for life. If a failed enrichment
 *      write failed the queue item, the requeue would search again for a client
 *      whose verdict is already final.
 *
 *   3. EVERY FIELD IS STORED, ONLY AGREED FIELDS ARE SHOWN. That split is what
 *      turned "confirm the field list with the client" from a migration into an
 *      UPDATE - and what let M06 be built before the list arrived at all.
 */

const K_BUSINESS = '111111';
const LOCATION = 'loc-1';
const config = {
  env: 'dev',
  wl: { kBusiness: K_BUSINESS },
  ghl: { locationId: LOCATION },
} as unknown as AppConfig;

/** A contact in the shape GoHighLevel actually returns. */
const contact = (over: Partial<GhlContact> = {}): GhlContact => ({
  id: 'C1',
  locationId: LOCATION,
  email: null,
  phone: '+15550000000',
  firstName: null,
  lastName: null,
  raw: {
    id: 'C1',
    locationId: LOCATION,
    customFields: [{ id: 'ibhlYPvuAeAA3N8iJqv6', value: 'PIANO' }],
    tags: ['wellness member', 'clf'],
  },
  ...over,
});

const response = (over: Partial<GhlSearchResponse> = {}): GhlSearchResponse => ({
  contacts: [],
  total: 0,
  latencyMs: 12,
  httpStatus: 200,
  body: { contacts: [], traceId: 'ghl-trace-1' },
  ghlTraceId: 'ghl-trace-1',
  requestParams: { locationId: LOCATION, pageLimit: 20, filters: [] },
  ...over,
});

const ghlError = () =>
  new GhlRequestError('transient', 'GoHighLevel is transient', {
    path: '/contacts/search',
    httpStatus: 503,
    latencyMs: 5,
    retryAfterMs: null,
    attempts: 3,
  });

// -----------------------------------------------------------------------------
// A minimal db double that records every write, and can be told to fail one.
// -----------------------------------------------------------------------------
interface Written {
  readonly table: string;
  readonly rows: readonly unknown[];
  readonly onConflict?: string | undefined;
}

interface Read {
  readonly table: string;
  readonly query: string;
}

function fakeDb(options: { failOn?: string; knownFields?: string[] | undefined } = {}): {
  db: SupabaseClient;
  writes: Written[];
  reads: Read[];
  patches: Record<string, unknown>[];
} {
  const writes: Written[] = [];
  const reads: Read[] = [];
  const patches: Record<string, unknown>[] = [];
  const queueItem = {
    id: 'q1',
    work_type: 'ghl_contact_match',
    target_key: 'u1',
    k_business: K_BUSINESS,
    attempt_count: 0,
  };
  let claimed = false;

  const guard = (table: string): void => {
    if (options.failOn === table) {
      throw new Error(`write to ${table} refused`);
    }
  };

  const db = {
    insert: vi.fn((table: string, rows: unknown[]) => {
      guard(table);
      writes.push({ table, rows });
      return Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : [{ id: 'raw-1' }]);
    }),
    upsert: vi.fn((table: string, rows: unknown[], options?: { onConflict: string }) => {
      guard(table);
      writes.push({ table, rows, onConflict: options?.onConflict });
      return Promise.resolve(rows);
    }),
    update: vi.fn((table: string, patch: Record<string, unknown>, query?: string) => {
      guard(table);
      if (table === 'person') patches.push(patch);
      if (table === 'sync_queue' && (query ?? '').includes('id=eq.') && !claimed) {
        claimed = true;
        return Promise.resolve([queueItem]);
      }
      return Promise.resolve([]);
    }),
    select: vi.fn((table: string, query: string) => {
      reads.push({ table, query });
      if (table === 'ghl_custom_field') {
        return Promise.resolve((options.knownFields ?? []).map((id) => ({ ghl_field_id: id })));
      }
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

  return { db, writes, reads, patches };
}

const rowsFor = (writes: Written[], table: string): Record<string, unknown>[] =>
  writes.filter((w) => w.table === table).flatMap((w) => w.rows as Record<string, unknown>[]);

// =============================================================================
// 1. The projection
// =============================================================================
describe('what a stored GoHighLevel contact keeps', () => {
  it('reads custom fields into an id-keyed object, because GHL sends no names', () => {
    const snap = contactSnapshot(contact());
    expect(snap?.fields).toEqual({ ibhlYPvuAeAA3N8iJqv6: 'PIANO' });
  });

  // A single-select field sends a string, a multi-select sends an array.
  // Coercing the second into the first would lose the difference silently.
  it('keeps a multi-select array as an array rather than flattening it', () => {
    const snap = contactSnapshot(
      contact({ raw: { customFields: [{ id: 'F', value: ['DJ', 'VOICE'] }], tags: [] } }),
    );
    expect(snap?.fields).toEqual({ F: ['DJ', 'VOICE'] });
  });

  // 254 of 325 contacts measured. The normal case, not a fault.
  it('treats an empty custom field bag as empty, not as missing', () => {
    const snap = contactSnapshot(contact({ raw: { customFields: [], tags: ['closed'] } }));
    expect(snap?.fields).toEqual({});
    expect(snap?.tags).toEqual(['closed']);
  });

  // The measurement says what GoHighLevel does today, not after a release. A
  // re-parse that throws would take a sync down for supplementary data.
  it('survives customFields arriving as something other than an array', () => {
    const snap = contactSnapshot(contact({ raw: { customFields: { a: 1 }, tags: null } }));
    expect(snap?.fields).toEqual({});
    expect(snap?.tags).toEqual([]);
  });

  it('skips a custom field entry with no usable id', () => {
    const snap = contactSnapshot(
      contact({
        raw: {
          customFields: [{ value: 'orphan' }, { id: '', value: 'x' }, { id: 'F', value: 'k' }],
          tags: [],
        },
      }),
    );
    expect(snap?.fields).toEqual({ F: 'k' });
  });

  // Order carries no meaning we know of, so sorting would be inventing one -
  // and would make a stored set compare unequal against its raw payload.
  it('keeps tags in the order GoHighLevel sent them', () => {
    const snap = contactSnapshot(
      contact({ raw: { customFields: [], tags: ['wellness member', 'closed', 'clf'] } }),
    );
    expect(snap?.tags).toEqual(['wellness member', 'closed', 'clf']);
  });

  // tags is text[]. A number arriving here means the field is not what we think
  // it is, and String(...) would hide that behind a plausible value.
  it('drops a non-string tag rather than stringifying it into text[]', () => {
    const snap = contactSnapshot(
      contact({ raw: { customFields: [], tags: ['closed', 7, null, { a: 1 }] } }),
    );
    expect(snap?.tags).toEqual(['closed']);
  });

  // Same judgement the matcher makes. Keyed by an empty string, every id-less
  // contact would overwrite the same single row in turn.
  it('refuses a contact with no id, because there is nothing to key a row by', () => {
    expect(contactSnapshot(contact({ id: '' }))).toBeNull();
  });

  it('falls back to nothing rather than guessing when the contact names no location', () => {
    const snap = contactSnapshot(contact({ locationId: '' }));
    expect(snap?.locationId).toBe('');
  });
});

// =============================================================================
// 2. The write
// =============================================================================
describe('the enrichment is stored per contact, not per person', () => {
  const store = async (
    over: { snapshotFrom?: GhlContact; knownFields?: string[] | undefined } = {},
  ): Promise<{ writes: Written[]; reads: Read[] }> => {
    const { db, writes, reads } = fakeDb({ knownFields: over.knownFields });
    const snapshot = contactSnapshot(over.snapshotFrom ?? contact());
    if (snapshot === null) throw new Error('fixture should project');
    await upsertGhlContact(db, {
      snapshot,
      fetchedAt: '2026-08-27T10:00:00.000Z',
      rawGhlId: 'raw-1',
      locationId: LOCATION,
    });
    return { writes, reads };
  };

  // The property the whole table shape exists for.
  it('upserts on the contact id, so a family sharing a contact stores one row', async () => {
    const { writes } = await store();

    const write = writes.find((w) => w.table === 'ghl_contact');
    expect(write?.onConflict).toBe('ghl_contact_id');
  });

  it('records when GoHighLevel was asked', async () => {
    const { writes } = await store();
    expect(rowsFor(writes, 'ghl_contact')[0]?.fetched_at).toBe('2026-08-27T10:00:00.000Z');
  });

  it('points at the payload it was parsed out of', async () => {
    const { writes } = await store();
    expect(rowsFor(writes, 'ghl_contact')[0]?.raw_ghl_id).toBe('raw-1');
  });

  // Replace, not merge: a tag GoHighLevel has retired must be able to leave.
  it('writes the whole tag set, so a retired tag can disappear', async () => {
    const { writes } = await store();
    expect(rowsFor(writes, 'ghl_contact')[0]?.tags).toEqual(['wellness member', 'clf']);
  });

  it('uses the configured location only when the contact named none', async () => {
    const { writes } = await store({ snapshotFrom: contact({ locationId: '' }) });
    expect(rowsFor(writes, 'ghl_contact')[0]?.location_id).toBe(LOCATION);
  });

  it('registers an unseen field id with no name and not reported', async () => {
    const { writes } = await store();
    expect(rowsFor(writes, 'ghl_custom_field')).toEqual([{ ghl_field_id: 'ibhlYPvuAeAA3N8iJqv6' }]);
  });

  /**
   * 78% of contacts carry no custom field, so the catalogue read is skipped for
   * them entirely - otherwise it is a query per client that can never find
   * anything to do.
   *
   * Asserted on the READ, not on the writes. Without the early return there is
   * still nothing to write, so a write-only assertion would pass while the query
   * happened anyway - which is exactly what it did before this was fixed.
   */
  it('does not even read the catalogue when the contact carries no custom field', async () => {
    const { writes, reads } = await store({
      snapshotFrom: contact({ raw: { customFields: [], tags: [] } }),
    });

    expect(reads.filter((r) => r.table === 'ghl_custom_field')).toEqual([]);
    expect(rowsFor(writes, 'ghl_custom_field')).toEqual([]);
  });

  // An unconditional upsert would move updated_at on a row that did not change,
  // and 0006 defines updated_at as when the row last CHANGED.
  it('does not re-register a field id already in the catalogue', async () => {
    const { writes } = await store({ knownFields: ['ibhlYPvuAeAA3N8iJqv6'] });
    expect(rowsFor(writes, 'ghl_custom_field')).toEqual([]);
  });
});

// =============================================================================
// 3. Riding along with the match
// =============================================================================
describe('the enrichment rides along with the match', () => {
  const matching = () => ({
    searchContacts: vi.fn(() => Promise.resolve(response({ contacts: [contact()], total: 1 }))),
  });

  const run = (db: SupabaseClient, ghl: { searchContacts: () => Promise<GhlSearchResponse> }) =>
    runGhlMatchSyncPass(config, { db, ghl, now: () => 0, budgetMs: 5_000 });

  it('stores the contact fields and tags on a match', async () => {
    const { db, writes } = fakeDb();
    await run(db, matching());

    const row = rowsFor(writes, 'ghl_contact')[0];
    expect(row?.ghl_contact_id).toBe('C1');
    expect(row?.fields).toEqual({ ibhlYPvuAeAA3N8iJqv6: 'PIANO' });
    expect(row?.tags).toEqual(['wellness member', 'clf']);
  });

  // No second request: the enrichment is projected from the search that just
  // decided the match, which is what keeps fetch-once free.
  it('costs no extra GoHighLevel call', async () => {
    const { db } = fakeDb();
    const ghl = matching();
    await run(db, ghl);

    expect(ghl.searchContacts).toHaveBeenCalledTimes(1);
  });

  it('links the row to the payload the match was decided from', async () => {
    const { db, writes } = fakeDb();
    await run(db, matching());

    expect(rowsFor(writes, 'ghl_contact')[0]?.raw_ghl_id).toBe('raw-1');
  });

  it('stores nothing when nobody matched', async () => {
    const { db, writes } = fakeDb();
    await run(db, { searchContacts: () => Promise.resolve(response()) });

    expect(rowsFor(writes, 'ghl_contact')).toEqual([]);
  });

  // Ambiguous is never auto-resolved, so there is no contact to enrich - storing
  // a candidate would put one person's data on another person's record.
  it('stores nothing when the search was ambiguous', async () => {
    const { db, writes } = fakeDb();
    await run(db, {
      searchContacts: () =>
        Promise.resolve(response({ contacts: [contact(), contact({ id: 'C2' })], total: 2 })),
    });

    expect(rowsFor(writes, 'ghl_contact')).toEqual([]);
  });

  it('stores no enrichment when GoHighLevel is down', async () => {
    const { db, writes } = fakeDb();
    await run(db, { searchContacts: () => Promise.reject(ghlError()) });

    expect(rowsFor(writes, 'ghl_contact')).toEqual([]);
  });
});

// =============================================================================
// 4. A failed enrichment write must not cost a second search
// =============================================================================
describe('a failed enrichment write is absorbed, not retried', () => {
  const matching = () => ({
    searchContacts: vi.fn(() => Promise.resolve(response({ contacts: [contact()], total: 1 }))),
  });

  const run = (db: SupabaseClient, ghl: { searchContacts: () => Promise<GhlSearchResponse> }) =>
    runGhlMatchSyncPass(config, { db, ghl, now: () => 0, budgetMs: 5_000 });

  it('still reports a successful run', async () => {
    const { db } = fakeDb({ failOn: 'ghl_contact' });
    const summary = await run(db, matching());

    expect(summary.state).not.toBe('failed');
    expect(summary.error).toBeUndefined();
  });

  /**
   * The load-bearing one. A requeue here would send the matcher back to
   * GoHighLevel for a client whose verdict is already final, breaking the rule
   * that a client is searched exactly once.
   */
  it('settles the item as done rather than requeueing it', async () => {
    const { db } = fakeDb({ failOn: 'ghl_contact' });
    const summary = await run(db, matching());

    expect(summary.done).toBe(1);
    expect(summary.requeued).toBe(0);
    expect(summary.dead).toBe(0);
  });

  // The verdict is the fact that matters, and it is written first for exactly
  // this reason.
  it('keeps the match verdict it had already decided', async () => {
    const { db, patches } = fakeDb({ failOn: 'ghl_contact' });
    await run(db, matching());

    expect(patches[0]?.ghl_match_state).toBe('matched');
    expect(patches[0]?.ghl_contact_id).toBe('C1');
  });

  // Nothing is swallowed in the sense of being lost: a matched client with no
  // ghl_contact row IS data_health_issue.missing_ghl_enrichment, and 0026's
  // backfill closes it from raw_ghl with no API call.
  it('leaves the raw payload stored, so the gap can be closed without GoHighLevel', async () => {
    const { db, writes } = fakeDb({ failOn: 'ghl_contact' });
    await run(db, matching());

    expect(rowsFor(writes, 'raw_ghl')).toHaveLength(1);
    expect(rowsFor(writes, 'raw_ghl')[0]?.person_uid).toBe('u1');
  });
});
