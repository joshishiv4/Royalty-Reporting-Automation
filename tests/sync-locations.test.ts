import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseLocationList, writeLocationList } from '../src/sync/locations.js';

const KB = '111111';

function locationBody(): unknown {
  return {
    a_location: {
      '0': {
        k_location: 'loc-1',
        s_title: 'The Spin DJ Academy',
        k_timezone: '65',
        a_timezone: { text_name: 'America/New_York', text_abbr: 'ET' },
      },
      '1': { s_title: 'No key here' }, // no k_location -> skipped
    },
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'r.1', kLog: null, httpStatus: 200, latencyMs: 3 };
}

describe('parseLocationList', () => {
  it('maps title and the IANA timezone, skipping keyless records', () => {
    const rows = parseLocationList(locationBody(), KB);
    expect(rows).toEqual([
      {
        k_location: 'loc-1',
        k_business: KB,
        title: 'The Spin DJ Academy',
        text_timezone: 'America/New_York', // from a_timezone.text_name, not k_timezone
      },
    ]);
  });

  it('returns nothing for a body without a_location', () => {
    expect(parseLocationList({}, KB)).toEqual([]);
  });
});

describe('writeLocationList', () => {
  it('stores raw, then upserts locations on k_location and links them', async () => {
    const calls: Array<{ op: string; table: string; onConflict?: string }> = [];
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-l' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], opts: { onConflict: string }) => {
        calls.push({ op: 'upsert', table, onConflict: opts.onConflict });
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;

    const result = await writeLocationList(db, {
      kBusiness: KB,
      response: response(locationBody()),
      runId: 'run',
    });

    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual([
      'insert:raw_wl',
      'upsert:location',
      'insert:raw_link',
    ]);
    expect(calls.find((c) => c.table === 'location')!.onConflict).toBe('k_location');
    expect(result.count).toBe(1);
  });
});
