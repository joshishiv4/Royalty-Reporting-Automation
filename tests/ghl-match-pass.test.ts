import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import { runGhlMatchSyncPass } from '../src/sync/pass.js';

/**
 * Matching is a ONE-TIME operation per client (PRD M04 follow-on), and the whole
 * cost argument for this integration rests on it: roughly one GoHighLevel search
 * per client for the life of the system, not that many every run.
 *
 * These tests are about WHO gets seeded, which is where that property lives. The
 * matching rules themselves are in ghl-matcher.test.ts.
 */

const K_BUSINESS = '111111';
const config = { env: 'dev', wl: { kBusiness: K_BUSINESS }, ghl: {} } as unknown as AppConfig;

/** Captures the seed query so we can assert what the pass asked the database for. */
function harness(seedRows: Array<{ uid: string }> = []) {
  const seedQueries: string[] = [];
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
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
    ),
    upsert: vi.fn((_t: string, rows: unknown[]) => Promise.resolve(rows)),
    update: vi.fn((table: string, patch: Record<string, unknown>, query?: string) => {
      if (table === 'person') patches.push(patch);
      // The claim CAS, handed out exactly once.
      if (table === 'sync_queue' && (query ?? '').includes('id=eq.') && !claimed) {
        claimed = true;
        return Promise.resolve([queueItem]);
      }
      return Promise.resolve([]);
    }),
    select: vi.fn((table: string, query: string) => {
      if (table === 'person' && query.includes('select=uid') && !query.includes('phone')) {
        seedQueries.push(query);
        return Promise.resolve(seedRows);
      }
      // The handler reading back the person it claimed.
      if (table === 'person' && query.includes('phone')) {
        return Promise.resolve([{ uid: 'u1', phone: '+15550000000', email: null }]);
      }
      if (table === 'sync_queue' && query.includes('order=next_attempt_at.asc') && !claimed) {
        return Promise.resolve([queueItem]);
      }
      return Promise.resolve([]);
    }),
  } as unknown as SupabaseClient;

  const ghl = {
    searchContacts: vi.fn(() =>
      Promise.resolve({ contacts: [], total: 0, latencyMs: 1, httpStatus: 200 }),
    ),
  };
  return { db, ghl, seedQueries, patches };
}

const run = (h: ReturnType<typeof harness>, retryUnresolved?: boolean) =>
  runGhlMatchSyncPass(config, {
    db: h.db,
    ghl: h.ghl,
    now: () => 0,
    budgetMs: 5_000,
    ...(retryUnresolved === undefined ? {} : { retryUnresolved }),
  });

describe('the automatic run matches only clients nobody has searched for', () => {
  // 'unmatched' is the DEFAULT state, so it cannot distinguish "never looked"
  // from "looked and found nobody". The attempt timestamp is what does.
  it('seeds on the attempt timestamp being null, not on the match state', async () => {
    const h = harness();
    await run(h);

    expect(h.seedQueries).toHaveLength(1);
    expect(h.seedQueries[0]).toContain('ghl_match_attempted_at=is.null');
  });

  // The criterion: a resolved client is never re-queried, including by the
  // weekly full refresh. The recurring path must not mention state at all.
  it('never asks for matched clients on the recurring path', async () => {
    const h = harness();
    await run(h);

    expect(h.seedQueries[0]).not.toContain('ghl_match_state');
  });

  it('scopes the seed to the business', async () => {
    const h = harness();
    await run(h);

    expect(h.seedQueries[0]).toContain(`k_business=eq.${K_BUSINESS}`);
  });
});

describe('a retry is deliberate, and covers only the unresolved', () => {
  it('does NOT happen unless explicitly asked for', async () => {
    const h = harness();
    await run(h); // no flag: the shape a scheduled run takes

    expect(h.seedQueries[0]).not.toContain('ghl_match_state=in.');
  });

  it('picks up unmatched and ambiguous when asked', async () => {
    const h = harness();
    await run(h, true);

    expect(h.seedQueries[0]).toContain('unmatched');
    expect(h.seedQueries[0]).toContain('ambiguous');
  });

  // Not named in the criteria, but 'failed' is not resolved either - excluding
  // it would strand the row with no route back and nobody would notice.
  it('includes failed, which is unresolved for a data reason', async () => {
    const h = harness();
    await run(h, true);

    expect(h.seedQueries[0]).toContain('failed');
  });

  it('still never re-queries a matched client, even on a retry', async () => {
    const h = harness();
    await run(h, true);

    const q = h.seedQueries[0] ?? '';
    const inList = /ghl_match_state=in\.\(([^)]*)\)/.exec(q)?.[1] ?? '';
    expect(inList.split(',')).not.toContain('matched');
  });
});

describe('every attempt is recorded, match or not', () => {
  /**
   * Without this the automatic seed - "who has never been searched for" - picks
   * the same people out again on every single run, forever. The cost argument
   * for the whole integration rests on this one write.
   */
  it('stamps the attempt time even when nothing matched', async () => {
    const h = harness([{ uid: 'u1' }]);
    await run(h);

    expect(h.patches).toHaveLength(1);
    expect(h.patches[0]).toHaveProperty('ghl_match_attempted_at');
    expect(h.patches[0]?.ghl_match_state).toBe('unmatched');
  });

  it('clears any stale contact id on a non-match', async () => {
    const h = harness([{ uid: 'u1' }]);
    await run(h);

    expect(h.patches[0]?.ghl_contact_id).toBeNull();
  });
});
