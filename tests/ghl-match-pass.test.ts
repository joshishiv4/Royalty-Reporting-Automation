import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { GhlContact } from '../src/ghl/client.js';
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
const config = {
  env: 'dev',
  wl: { kBusiness: K_BUSINESS },
  ghl: {},
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
} as unknown as AppConfig;

const contact = (id: string): GhlContact => ({
  id,
  locationId: 'loc-1',
  email: null,
  phone: null,
  firstName: null,
  lastName: null,
  raw: {},
});

/** Captures the seed query so we can assert what the pass asked the database for. */
function harness(
  seedRows: Array<{ uid: string }> = [],
  opts: { person?: Record<string, unknown>; contacts?: GhlContact[] } = {},
) {
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
        return Promise.resolve([
          {
            uid: 'u1',
            phone: '+15550000000',
            email: null,
            ghl_unresolved_since: null,
            ...opts.person,
          },
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

  const ghl = {
    searchContacts: vi.fn((_filters: { email?: string; phone?: string }) => {
      const contacts = opts.contacts ?? [];
      return Promise.resolve({
        contacts,
        total: contacts.length,
        latencyMs: 1,
        httpStatus: 200,
        body: { contacts, traceId: 'trace-1' },
        ghlTraceId: 'trace-1',
        requestParams: { ..._filters },
      });
    }),
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

/**
 * Board item M05. Neither outcome here is an error, and that is exactly why
 * they need tests: "normal" is the behaviour that quietly stops being checked.
 */
describe('no match is an outcome, not a failure', () => {
  it('completes the work item rather than dead-lettering it', async () => {
    const h = harness([{ uid: 'u1' }]);
    const summary = await run(h);

    expect(summary.done).toBe(1);
    expect(summary.dead).toBe(0);
  });

  // The link is left empty on purpose. Nothing is created in GoHighLevel to
  // fill the gap, so 'matched' always means a contact that already existed.
  it('leaves the link empty and says so in the state', async () => {
    const h = harness([{ uid: 'u1' }]);
    await run(h);

    expect(h.patches[0]?.ghl_contact_id).toBeNull();
    expect(h.patches[0]?.ghl_match_state).toBe('unmatched');
  });
});

describe('the unresolved clock survives retries', () => {
  /**
   * The 48-hour alert measures how long a HUMAN has left something unresolved.
   * Built on ghl_match_attempted_at it would measure how recently a job ran -
   * every deliberate retry would reset it, and a record ambiguous for a month
   * would read as brand new. An alert that cannot fire reports safety.
   */
  it('starts the clock on the first non-matching outcome', async () => {
    const h = harness([{ uid: 'u1' }]);
    await run(h);

    expect(h.patches[0]?.ghl_unresolved_since).not.toBeNull();
  });

  it('does NOT reset the clock when a retry finds nothing again', async () => {
    const started = '2026-01-01T00:00:00.000Z';
    const h = harness([{ uid: 'u1' }], { person: { ghl_unresolved_since: started } });
    await run(h, true);

    expect(h.patches[0]?.ghl_unresolved_since).toBe(started);
    // ...while the attempt time still moves, so "when did we last look" stays
    // answerable. Two clocks, two questions.
    expect(h.patches[0]?.ghl_match_attempted_at).not.toBe(started);
  });

  it('clears the clock the moment a contact is found', async () => {
    const h = harness([{ uid: 'u1' }], {
      person: { ghl_unresolved_since: '2026-01-01T00:00:00.000Z' },
      contacts: [contact('ghl-7')],
    });
    await run(h);

    expect(h.patches[0]?.ghl_match_state).toBe('matched');
    expect(h.patches[0]?.ghl_contact_id).toBe('ghl-7');
    expect(h.patches[0]?.ghl_unresolved_since).toBeNull();
  });
});

describe('the matcher is told nothing it must not use', () => {
  // Names are never used for matching. The person row now carries more columns
  // than it did, so this asserts the subject handed over is still exactly the
  // three fields - a name added to person cannot leak into a search.
  it('passes only uid, phone and email to the matcher', async () => {
    const h = harness([{ uid: 'u1' }], {
      person: { first_name: 'Ada', last_name: 'Lovelace' },
    });
    await run(h);

    for (const [filters] of h.ghl.searchContacts.mock.calls) {
      expect(Object.keys(filters).every((k) => k === 'phone' || k === 'email')).toBe(true);
    }
  });
});
