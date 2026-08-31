import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseStaffList, writeStaffList } from '../src/sync/writer.js';

const K_BUSINESS = '111111';

/** A staff/list body in WL's shape: a keyed object, not an array. */
function staffBody(): unknown {
  return {
    a_staff: {
      '0': {
        uid: '0771',
        k_staff: '55',
        s_name: 'Ada',
        s_surname: 'Lovelace',
        is_class: '1',
        is_event: 0,
      },
      '1': {
        uid: '0980',
        k_staff: '56',
        s_name: 'Alan',
        s_surname: 'Turing',
        is_class: true,
        is_appointment: '1',
      },
    },
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'run.1', kLog: '[9.9x]', httpStatus: 200, latencyMs: 42 };
}

describe('parseStaffList', () => {
  it('maps a keyed staff object to person rows, keeping keys as text', () => {
    const rows = parseStaffList(staffBody(), K_BUSINESS);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      uid: '0771', // leading zero preserved: text, not a number
      k_business: K_BUSINESS,
      k_staff: '55',
      is_class: true,
      is_appointment: false,
      is_event: false,
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    // WL booleans arrive as "1" / 1 / true across endpoints; all mean true.
    expect(rows[1]!.is_class).toBe(true);
    expect(rows[1]!.is_appointment).toBe(true);
  });

  it('skips a record with no uid - nothing to key on', () => {
    const rows = parseStaffList({ a_staff: { '0': { s_name: 'No Key' } } }, K_BUSINESS);
    expect(rows).toEqual([]);
  });

  it('returns nothing for a body without a_staff', () => {
    expect(parseStaffList({}, K_BUSINESS)).toEqual([]);
    expect(parseStaffList(null, K_BUSINESS)).toEqual([]);
  });
});

describe('writeStaffList', () => {
  function fakeDb() {
    const calls: Array<{ op: string; table: string; rows: unknown[]; onConflict?: string }> = [];
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-1' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], opts: { onConflict: string }) => {
        calls.push({ op: 'upsert', table, rows, onConflict: opts.onConflict });
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  it('stores raw first, upserts person on uid, then links each row to the payload', async () => {
    const { db, calls } = fakeDb();

    const result = await writeStaffList(db, {
      kBusiness: K_BUSINESS,
      response: response(staffBody()),
      runId: 'run',
    });

    // Order matters: the payload must be on disk before typed rows reference it.
    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual([
      'insert:raw_wl',
      'upsert:person',
      'insert:raw_link',
    ]);
    expect(calls[1]!.onConflict).toBe('uid');
    // raw_wl carries the trace id and status from the response.
    expect((calls[0]!.rows[0] as { trace_id: string }).trace_id).toBe('run.1');
    // one link per person, keyed by uid, pointing at the stored payload.
    expect(calls[2]!.rows).toHaveLength(2);
    expect(calls[2]!.rows[0]).toMatchObject({
      raw_wl_id: 'raw-1',
      table_name: 'person',
      record_key: '0771',
    });
    expect(result.rawWlId).toBe('raw-1');
    expect(result.persons).toHaveLength(2);
  });

  it('stores the raw payload even when there are no parseable rows', async () => {
    const { db, calls } = fakeDb();
    await writeStaffList(db, { kBusiness: K_BUSINESS, response: response({}), runId: 'run' });
    // The payload is still captured; only the typed writes are skipped.
    expect(calls.map((c) => c.table)).toEqual(['raw_wl']);
  });
});
