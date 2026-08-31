import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import {
  parseServiceCategoryList,
  parseServiceList,
  writeServiceCategoryList,
  writeServiceList,
} from '../src/sync/services.js';

const KB = '111111';

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'r.1', kLog: null, httpStatus: 200, latencyMs: 3 };
}

// Shapes probed live 24 Aug 2026 at k_location 244238.

// a_category is an ARRAY; i_sort a numeric string; s_title the name.
function categoryBody(): unknown {
  return {
    a_category: [
      {
        hide_application: false,
        i_sort: '29932',
        k_service_category: '32208',
        s_title: 'Music Lessons',
      },
      {
        hide_application: false,
        i_sort: '29933',
        k_service_category: '29931',
        s_title: 'DJ Lessons',
      },
      { s_title: 'No key here' }, // no k_service_category -> skipped
    ],
  };
}

// a_service is a KEYED OBJECT; title is s_service; duration is i_duration_real.
function serviceBody(): unknown {
  return {
    a_service: {
      '142048': {
        k_service: '142048',
        s_service: 'Music Private | Virtual | 45 Minutes',
        k_service_category: '32208',
        i_duration_real: 45,
        i_duration: 0,
        is_bookable: true,
        is_online_sell: '1',
      },
      '142049': {
        k_service: '142049',
        s_service: 'Music Private | Virtual | 30 Minutes',
        k_service_category: '32208',
        i_duration_real: 30,
        is_bookable: true,
      },
      keyless: { s_service: 'no k_service' }, // skipped
    },
  };
}

describe('parseServiceCategoryList', () => {
  it('reads title, parses i_sort to an int, and skips keyless records (array shape)', () => {
    const rows = parseServiceCategoryList(categoryBody(), KB);
    expect(rows).toEqual([
      {
        k_service_category: '32208',
        k_business: KB,
        title: 'Music Lessons',
        i_sort: 29932, // "29932" -> 29932, not the string
        hide_application: false,
      },
      {
        k_service_category: '29931',
        k_business: KB,
        title: 'DJ Lessons',
        i_sort: 29933,
        hide_application: false,
      },
    ]);
  });

  it('also accepts a keyed object, not only an array', () => {
    const keyed = { a_category: { '0': { k_service_category: 'c-1', s_title: 'X' } } };
    expect(parseServiceCategoryList(keyed, KB)).toHaveLength(1);
  });

  it('returns nothing for a body without a_category', () => {
    expect(parseServiceCategoryList({}, KB)).toEqual([]);
  });
});

describe('parseServiceList', () => {
  it('maps title from s_service, duration from i_duration_real, and marks resolved', () => {
    const rows = parseServiceList(serviceBody(), KB);
    expect(rows).toEqual([
      {
        k_service: '142048',
        k_business: KB,
        title: 'Music Private | Virtual | 45 Minutes',
        k_service_category: '32208',
        i_duration: 45,
        is_bookable: true,
        is_resolved: true,
      },
      {
        k_service: '142049',
        k_business: KB,
        title: 'Music Private | Virtual | 30 Minutes',
        k_service_category: '32208',
        i_duration: 30,
        is_bookable: true,
        is_resolved: true,
      },
    ]);
  });

  it('every catalogue service is resolved (that is what the endpoint proves)', () => {
    const rows = parseServiceList(serviceBody(), KB);
    expect(rows.every((r) => r.is_resolved === true)).toBe(true);
  });

  it('never sends is_package, so it cannot clobber the purchase-derived value', () => {
    const rows = parseServiceList(serviceBody(), KB);
    expect(rows.every((r) => !('is_package' in r))).toBe(true);
  });

  it('returns nothing for a body without a_service', () => {
    expect(parseServiceList({}, KB)).toEqual([]);
  });
});

function recordingDb(rawId: string) {
  const calls: Array<{ op: string; table: string; onConflict?: string }> = [];
  const db = {
    // enqueue writes through a Postgres function now (migration 0032), so a
    // fake db has to answer it. It reports everything as inserted: these
    // tests are about what gets queued, not how Postgres resolves a clash.
    rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
    insert: vi.fn((table: string, rows: unknown[]) => {
      calls.push({ op: 'insert', table });
      return Promise.resolve(table === 'raw_wl' ? [{ id: rawId }] : rows);
    }),
    upsert: vi.fn((table: string, rows: unknown[], opts: { onConflict: string }) => {
      calls.push({ op: 'upsert', table, onConflict: opts.onConflict });
      return Promise.resolve(rows);
    }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('writeServiceCategoryList', () => {
  it('stores raw, upserts on k_service_category, and links them', async () => {
    const { db, calls } = recordingDb('raw-sc');
    const result = await writeServiceCategoryList(db, {
      kBusiness: KB,
      kLocation: '244238',
      response: response(categoryBody()),
      runId: 'run',
    });
    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual([
      'insert:raw_wl',
      'upsert:service_category',
      'insert:raw_link',
    ]);
    expect(calls.find((c) => c.table === 'service_category')!.onConflict).toBe(
      'k_service_category',
    );
    expect(result.count).toBe(2);
  });
});

describe('writeServiceList', () => {
  it('stores raw, upserts on k_service, and links them', async () => {
    const { db, calls } = recordingDb('raw-s');
    const result = await writeServiceList(db, {
      kBusiness: KB,
      kLocation: '244238',
      response: response(serviceBody()),
      runId: 'run',
    });
    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual([
      'insert:raw_wl',
      'upsert:service',
      'insert:raw_link',
    ]);
    expect(calls.find((c) => c.table === 'service')!.onConflict).toBe('k_service');
    expect(result.count).toBe(2);
  });
});
