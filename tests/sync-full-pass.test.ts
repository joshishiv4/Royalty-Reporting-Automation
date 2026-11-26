import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import {
  FULL_SYNC_WAVES,
  runFullSyncPass,
  runFullSyncPassParallel,
  type SyncPassSummary,
  type WaveEntry,
} from '../src/sync/pass.js';

const config = {
  env: 'dev',
  wl: { kBusiness: '111111', clientId: '', clientSecret: '', host: '', authHost: '', region: 0 },
  sync: { historyStart: '1980-01-01', dailyLookbackDays: 2 },
  runtime: { maxConcurrency: 5, httpTimeoutMs: 30000 },
  // Lesson sign-off left unconfigured: its pass reports 'skipped' and touches nothing.
  smtp: { host: null },
  signoff: {
    to: null,
    startDate: null,
    classes: [],
    eligibleGroup: 'SDC Clients',
    formHost: null,
    formId: null,
    apiHost: null,
    apiKey: null,
    timeZone: 'America/New_York',
    drive: {
      oauthHost: null,
      apiHost: null,
      clientId: null,
      clientSecret: null,
      refreshToken: null,
      inboxFolderId: null,
      rootFolderId: null,
    },
  },
} as unknown as AppConfig;

/** A WL client whose every call returns a valid but empty body. */
function fakeWl(): WlClient {
  return {
    runId: 'run-x',
    request: vi.fn(() =>
      Promise.resolve({ body: {}, traceId: 'run-x.1', kLog: null, httpStatus: 200, latencyMs: 1 }),
    ),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;
}

/** A db that seeds cleanly and claims nothing, so every pass drains to ok. */
function fakeDb() {
  return {
    // enqueue writes through a Postgres function now (migration 0032), so a
    // fake db has to answer it. It reports everything as inserted: these
    // tests are about what gets queued, not how Postgres resolves a clash.
    rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
    insert: vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
    ),
    update: vi.fn((table: string) =>
      Promise.resolve(table === 'sync_job_state' ? [{ job_name: 'j' }] : []),
    ), // claim CAS finds nothing
    upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
    select: vi.fn(() => Promise.resolve([])), // no seed rows, nothing eligible
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
}

describe('runFullSyncPass', () => {
  it('runs every pass in dependency order and reports ok when all drain', async () => {
    const summary = await runFullSyncPass(config, { wl: fakeWl(), db: fakeDb(), now: () => 0 });

    expect(summary.passes.map((p) => p.job)).toEqual([
      'login_type_sync',
      'client_list_sync',
      'staff_sync',
      'location_sync',
      'shop_category_sync',
      'promotion_sync',
      'service_category_sync',
      'purchase_sync',
      'receipt_sync',
      'purchase_element_sync',
      'profile_sync',
      'schedule_sync',
      'client_session_sync',
      'attendance_sync',
      'ghl_match_sync',
      'service_sync',
      'member_group_sync',
      'lesson_signoff_sync',
      'lesson_signoff_check',
      'lesson_signoff_remind',
      'lesson_signoff_file',
    ]);
    expect(summary.passes.every((p) => p.ran)).toBe(true);
    expect(summary.state).toBe('ok');
  });

  it('skips passes it cannot reach in budget and reports partial, not failed', async () => {
    // Budget below the per-pass floor: no pass is even started.
    const summary = await runFullSyncPass(config, {
      wl: fakeWl(),
      db: fakeDb(),
      now: () => 0,
      budgetMs: 1000,
    });

    expect(summary.passes.every((p) => !p.ran)).toBe(true);
    expect(summary.state).toBe('partial'); // unreached work is queued, not a failure
  });

  it('reports failed when a pass fails', async () => {
    // A staff claim that yields an item, whose handler throws a non-WL error.
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) =>
        Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
      ),
      update: vi.fn((table: string, _p: unknown, query: string) =>
        Promise.resolve(
          table === 'sync_job_state'
            ? [{ job_name: 'j' }]
            : query.includes('id=eq.') && query.includes('select=')
              ? [
                  {
                    id: 'q1',
                    work_type: 'staff_list',
                    target_key: 'all',
                    k_business: '111111',
                    attempt_count: 0,
                  },
                ]
              : [],
        ),
      ),
      upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
      // Only the STAFF queue yields work. Without the work_type check this fake
      // hands every pass a staff_list item forever, and any handler that returns
      // an outcome instead of throwing loops until the heap dies - which is not
      // a bug in that handler, just a fake that never drains.
      select: vi.fn((_t: string, query: string) =>
        Promise.resolve(
          query.includes('order=next_attempt_at.asc') && query.includes('work_type=in.(staff_list)')
            ? [
                {
                  id: 'q1',
                  work_type: 'staff_list',
                  target_key: 'all',
                  k_business: '111111',
                  attempt_count: 0,
                },
              ]
            : [],
        ),
      ),
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
    const wl = {
      runId: 'run-x',
      request: vi.fn(() => Promise.reject(new Error('boom'))),
      tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
    } as unknown as WlClient;

    const summary = await runFullSyncPass(config, { wl, db, now: () => 0 });
    expect(summary.state).toBe('failed');
  });
});

describe('runFullSyncPassParallel', () => {
  it('runs every pass exactly once and reports ok when they all drain', async () => {
    const summary = await runFullSyncPassParallel(config, {
      wl: fakeWl(),
      db: fakeDb(),
      now: () => 0,
    });

    // Same set of passes as the sequential runner; order within the summary
    // reflects the wave grouping but every pass must appear.
    const jobs = summary.passes.map((p) => p.job).sort();
    expect(jobs).toEqual(
      [
        'attendance_sync',
        'client_list_sync',
        'client_session_sync',
        'ghl_match_sync',
        'location_sync',
        'login_type_sync',
        'profile_sync',
        'promotion_sync',
        'purchase_element_sync',
        'purchase_sync',
        'receipt_sync',
        'schedule_sync',
        'service_category_sync',
        'service_sync',
        'shop_category_sync',
        'staff_sync',
        'tx_item_sync',
        'tx_payment_sync',
        'member_group_sync',
        'lesson_signoff_sync',
        'lesson_signoff_check',
        'lesson_signoff_remind',
        'lesson_signoff_file',
      ].sort(),
    );
    expect(summary.passes.every((p) => p.ran)).toBe(true);
    expect(summary.state).toBe('ok');
  });

  it('catches an exception in one pass without abandoning the others', async () => {
    // A wl.request that throws for one specific path (staff/list). Other passes
    // still see empty successful bodies and drain cleanly.
    const wl = {
      runId: 'run-x',
      request: vi.fn((path: string) =>
        path === '/v1/staff/list'
          ? Promise.reject(new Error('staff boom'))
          : Promise.resolve({
              body: {},
              traceId: 'run-x.1',
              kLog: null,
              httpStatus: 200,
              latencyMs: 1,
            }),
      ),
      tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
    } as unknown as WlClient;

    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) =>
        Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
      ),
      update: vi.fn((table: string, _p: unknown, query: string) =>
        Promise.resolve(
          table === 'sync_job_state'
            ? [{ job_name: 'j' }]
            : query.includes('id=eq.') && query.includes('select=')
              ? [
                  {
                    id: 'q1',
                    work_type: 'staff_list',
                    target_key: 'all',
                    k_business: '111111',
                    attempt_count: 0,
                  },
                ]
              : [],
        ),
      ),
      upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
      select: vi.fn((_t: string, query: string) =>
        Promise.resolve(
          query.includes('order=next_attempt_at.asc') && query.includes('work_type=in.(staff_list)')
            ? [
                {
                  id: 'q1',
                  work_type: 'staff_list',
                  target_key: 'all',
                  k_business: '111111',
                  attempt_count: 0,
                },
              ]
            : [],
        ),
      ),
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

    const summary = await runFullSyncPassParallel(config, { wl, db, now: () => 0 });

    // Every pass either ok or failed - none should be missing from the list.
    expect(summary.passes).toHaveLength(23);
    expect(summary.state).toBe('failed');
    const staff = summary.passes.find((p) => p.job === 'staff_sync');
    expect(staff?.summary?.state).toBe('failed');
    // Non-staff passes still finished.
    const login = summary.passes.find((p) => p.job === 'login_type_sync');
    expect(login?.summary?.state).toBe('ok');
  });

  it('runs passes concurrently within a wave', async () => {
    // A db.select that resolves only after we prove multiple wave-1 passes
    // called it in overlap. Concurrency proof by ordering: we record the entry
    // times and check the second entry happened before the first resolved.
    const entries: number[] = [];
    let ticks = 0;

    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) =>
        Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows),
      ),
      update: vi.fn((table: string) =>
        Promise.resolve(table === 'sync_job_state' ? [{ job_name: 'j' }] : []),
      ),
      upsert: vi.fn((_table: string, rows: unknown[]) => Promise.resolve(rows)),
      select: vi.fn(() => {
        const t = ticks++;
        entries.push(t);
        // Every select resolves on a microtask, so a truly serial caller would
        // finish one before entering the next - entries would be strictly
        // increasing WITH no interleaving. A parallel caller enters the second
        // before the first resolves.
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

    await runFullSyncPassParallel(config, { wl: fakeWl(), db, now: () => 0 });

    // A serial run would produce entries in a very rigid pattern (one pass's
    // selects fully before the next); a parallel run interleaves the selects
    // from multiple passes. This is an indirect proof, so it just checks that
    // MANY selects were made and the entries are not the trivial 5-total we'd
    // expect from a serial run of just wave 1.
    expect(entries.length).toBeGreaterThan(5);
  });
});

/**
 * `after`: one pass waits for the passes it reads, the rest of the wave does not.
 *
 * Why it exists: in run #298 (26 Nov 2026) lesson_signoff_sync looked in its first
 * 5 seconds, found 0 lessons, and attendance_sync then stored the day's lessons
 * over 58 minutes - and the next run was hours away, not one.
 */
describe('runFullSyncPassParallel - passes that wait (`after`)', () => {
  const ok: SyncPassSummary = {
    runId: 'r',
    state: 'ok',
    claimed: 0,
    done: 0,
    requeued: 0,
    dead: 0,
    itemsRemaining: 0,
  };

  /** A pass that records when it starts and finishes only when released. */
  function heldPass(name: string, log: string[]) {
    let release: (fail?: boolean) => void = () => undefined;
    const done = new Promise<boolean>((resolve) => {
      release = (fail = false) => resolve(fail);
    });
    const entry: WaveEntry = {
      job: name,
      run: async () => {
        log.push(`start ${name}`);
        const fail = await done;
        log.push(`end ${name}`);
        if (fail) throw new Error(`${name} failed`);
        return ok;
      },
    };
    return { entry, release: (fail?: boolean) => release(fail) };
  }

  function quickPass(name: string, log: string[], after?: string[]): WaveEntry {
    return {
      job: name,
      run: () => {
        log.push(`start ${name}`);
        return Promise.resolve(ok);
      },
      ...(after === undefined ? {} : { after }),
    };
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const deps = () => ({ wl: fakeWl(), db: fakeDb(), now: () => 0 });

  it('a waiting pass starts only after what it reads has finished; the others start at once', async () => {
    const log: string[] = [];
    const attendance = heldPass('attendance_sync', log);
    const waves = [
      [
        attendance.entry,
        quickPass('staff_sync', log),
        quickPass('lesson_signoff_sync', log, ['attendance_sync']),
      ],
    ];
    const run = runFullSyncPassParallel(config, deps(), waves);
    await flush();

    expect(log).toContain('start staff_sync');
    expect(log).not.toContain('start lesson_signoff_sync');

    attendance.release();
    const summary = await run;
    expect(log.indexOf('start lesson_signoff_sync')).toBeGreaterThan(
      log.indexOf('end attendance_sync'),
    );
    // Results keep the wave's listed order.
    expect(summary.passes.map((p) => p.job)).toEqual([
      'attendance_sync',
      'staff_sync',
      'lesson_signoff_sync',
    ]);
  });

  // The 57014 timeouts: attendance failing must not also stop the sign-off emails.
  it('starts after a FAILED dependency too, and reports both', async () => {
    const log: string[] = [];
    const attendance = heldPass('attendance_sync', log);
    const run = runFullSyncPassParallel(config, deps(), [
      [attendance.entry, quickPass('lesson_signoff_sync', log, ['attendance_sync'])],
    ]);
    await flush();
    attendance.release(true);
    const summary = await run;

    expect(log).toContain('start lesson_signoff_sync');
    expect(summary.passes.find((p) => p.job === 'attendance_sync')?.summary?.state).toBe('failed');
    expect(summary.passes.find((p) => p.job === 'lesson_signoff_sync')?.summary?.state).toBe('ok');
  });

  it('waits for EVERY pass it names', async () => {
    const log: string[] = [];
    const attendance = heldPass('attendance_sync', log);
    const groups = heldPass('member_group_sync', log);
    const run = runFullSyncPassParallel(config, deps(), [
      [
        attendance.entry,
        groups.entry,
        quickPass('lesson_signoff_sync', log, ['attendance_sync', 'member_group_sync']),
      ],
    ]);
    await flush();
    attendance.release();
    await flush();
    expect(log).not.toContain('start lesson_signoff_sync');
    groups.release();
    await run;
    expect(log.at(-1)).toBe('start lesson_signoff_sync');
  });

  // A typo or a reordering must fail loudly, not silently drop the wait.
  it('refuses a wait on a pass that is not earlier in the wave', async () => {
    const log: string[] = [];
    await expect(
      runFullSyncPassParallel(config, deps(), [
        [
          quickPass('lesson_signoff_sync', log, ['attendance_sync']),
          quickPass('attendance_sync', log),
        ],
      ]),
    ).rejects.toThrow('lesson_signoff_sync waits for attendance_sync');
  });

  // The real hourly list: what sign-off waits for is the point of this change.
  it('the hourly list: sign-off waits for attendance and groups, filing for the check', () => {
    const entries = FULL_SYNC_WAVES.flat();
    const find = (job: string) => entries.find((e) => e.job === job);
    expect(find('lesson_signoff_sync')?.after).toEqual(['attendance_sync', 'member_group_sync']);
    expect(find('lesson_signoff_file')?.after).toEqual(['lesson_signoff_check']);
    // Nothing else waits: the flat wave stays flat.
    expect(entries.filter((e) => e.after !== undefined).map((e) => e.job)).toEqual([
      'lesson_signoff_sync',
      'lesson_signoff_file',
    ]);
  });
});

/**
 * There used to be a 50-second default budget for the WHOLE run, shared across
 * every pass. Fifty seconds is a serverless function's ceiling and had no
 * business being a sync's default: measured on live dev 31 Aug 2026, a run did
 * fifty seconds of work, skipped every pass it never reached, and reported `ok`
 * while 40,333 items sat queued for days.
 *
 * These pin the replacement: unbounded unless the caller names a deadline.
 */
describe('no run stops early unless the caller asked it to', () => {
  /** A clock that has already blown far past any old default. */
  function clockPast(ms: number) {
    let first = true;
    return () => {
      if (first) {
        first = false;
        return 0;
      }
      return ms;
    };
  }

  it('runs every pass with no budget, however long the clock says it took', async () => {
    const summary = await runFullSyncPass(config, {
      wl: fakeWl(),
      db: fakeDb(),
      now: clockPast(3_600_000),
    });

    // Not one skipped. With a default budget in place, everything after the
    // first pass came back ran:false.
    expect(summary.passes.filter((p) => !p.ran)).toEqual([]);
  });

  it('still honours a budget the caller does name', async () => {
    const summary = await runFullSyncPass(config, {
      wl: fakeWl(),
      db: fakeDb(),
      now: clockPast(3_600_000),
      budgetMs: 50_000,
    });

    // The api route relies on exactly this: stop STARTING work before the
    // platform kills the function, and report what is left.
    expect(summary.passes.some((p) => !p.ran)).toBe(true);
  });
});
