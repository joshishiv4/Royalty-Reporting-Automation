import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseLoginTypeList, writeLoginTypeList } from '../src/sync/login-types.js';

const K_BUSINESS = '111111';

/** Verbatim shapes from the live /v1/login/type probe, 24 Aug 2026. */
const STAFF_CLIENT = {
  id_client_type: 3,
  is_member: 1,
  k_login_type: '1260510',
  s_title: 'Staff Client Profile',
  text_title: 'Staff Client Profile',
};
const PROSPECT = {
  id_client_type: 1,
  is_member: null,
  k_login_type: '1234074',
  s_title: 'Prospect',
  text_title: 'Prospect',
};
const GROUP_CLASS = {
  id_client_type: 2,
  is_member: 0,
  k_login_type: '1253738',
  s_title: 'Group Class Client',
  text_title: 'Group Class Client',
};

function body(list: unknown): unknown {
  return { a_login_type_list: list, status: 'ok' };
}

function response(b: unknown): WlResponse<unknown> {
  return { body: b, traceId: 'lt.1', kLog: null, httpStatus: 200, latencyMs: 7 };
}

describe('parseLoginTypeList', () => {
  it('maps a login type, keeping the WL key as text', () => {
    expect(parseLoginTypeList(body([STAFF_CLIENT]), K_BUSINESS)).toEqual([
      {
        k_login_type: '1260510',
        k_business: K_BUSINESS,
        title: 'Staff Client Profile',
        id_client_type: 3,
        is_member: true,
      },
    ]);
  });

  // "Not a member" and "membership does not apply" are different facts, and WL
  // distinguishes them. Folding null to false would erase that.
  it('keeps is_member NULL for Prospect, distinct from false', () => {
    const [prospect] = parseLoginTypeList(body([PROSPECT]), K_BUSINESS);
    const [group] = parseLoginTypeList(body([GROUP_CLASS]), K_BUSINESS);
    expect(prospect?.is_member).toBeNull();
    expect(group?.is_member).toBe(false);
  });

  it('falls back to s_title when text_title is absent', () => {
    const [row] = parseLoginTypeList(
      body([{ ...STAFF_CLIENT, text_title: undefined }]),
      K_BUSINESS,
    );
    expect(row?.title).toBe('Staff Client Profile');
  });

  it('skips a record with no k_login_type rather than storing a keyless row', () => {
    expect(parseLoginTypeList(body([{ text_title: 'Nameless' }]), K_BUSINESS)).toEqual([]);
  });

  // WL serves this one as an array, unlike most list endpoints.
  it('accepts a keyed object as well as an array', () => {
    const asObject = { '1260510': STAFF_CLIENT, '1234074': PROSPECT };
    expect(parseLoginTypeList(body(asObject), K_BUSINESS)).toHaveLength(2);
  });

  it('returns nothing for a bare body', () => {
    expect(parseLoginTypeList({}, K_BUSINESS)).toEqual([]);
  });

  it('deduplicates a repeated key, which an upsert batch would reject', () => {
    expect(parseLoginTypeList(body([STAFF_CLIENT, STAFF_CLIENT]), K_BUSINESS)).toHaveLength(1);
  });
});

describe('writeLoginTypeList', () => {
  function fakeDb() {
    const calls: Array<{
      op: string;
      table: string;
      rows?: unknown[];
      options?: { onConflict?: string } | undefined;
    }> = [];
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-lt' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], options?: { onConflict?: string }) => {
        calls.push({ op: 'upsert', table, rows, options });
        return Promise.resolve(rows);
      }),
      update: vi.fn(() => Promise.resolve([])),
      select: vi.fn(() => Promise.resolve([])),
    };
    return { db: db as unknown as SupabaseClient, calls };
  }

  const input = (b: unknown) => ({
    kBusiness: K_BUSINESS,
    response: response(b),
    runId: 'run-1',
  });

  it('upserts on k_login_type so a re-sync refreshes rather than duplicates', async () => {
    const { db, calls } = fakeDb();
    const result = await writeLoginTypeList(db, input(body([STAFF_CLIENT, PROSPECT])));

    expect(result.count).toBe(2);
    const upsert = calls.find((c) => c.op === 'upsert' && c.table === 'login_type');
    expect(upsert?.options?.onConflict).toBe('k_login_type');
  });

  // is_teacher_type is the studio's decision, not WL's. WL has no opinion about
  // it, so the payload must not carry it - a PostgREST upsert writes only the
  // columns it is sent, and sending a default would silently un-flag the teacher
  // login type on every sync.
  it('NEVER sends is_teacher_type, so a re-sync cannot undo the studio choice', async () => {
    const { db, calls } = fakeDb();
    await writeLoginTypeList(db, input(body([STAFF_CLIENT])));

    const upsert = calls.find((c) => c.op === 'upsert' && c.table === 'login_type');
    for (const row of upsert?.rows ?? []) {
      expect(row).not.toHaveProperty('is_teacher_type');
    }
  });

  it('stores the raw payload and links every row to it', async () => {
    const { db, calls } = fakeDb();
    await writeLoginTypeList(db, input(body([STAFF_CLIENT, PROSPECT])));

    expect(calls.some((c) => c.table === 'raw_wl')).toBe(true);
    const link = calls.find((c) => c.table === 'raw_link');
    expect(link?.rows).toHaveLength(2);
  });

  it('writes nothing when the list is empty, but still stores the payload', async () => {
    const { db, calls } = fakeDb();
    const result = await writeLoginTypeList(db, input(body([])));

    expect(result.count).toBe(0);
    expect(calls.some((c) => c.table === 'raw_wl')).toBe(true);
    expect(calls.some((c) => c.op === 'upsert')).toBe(false);
  });
});
