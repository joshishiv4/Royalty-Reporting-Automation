import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseMemberGroupList, writeMemberGroupList } from '../src/sync/member-groups.js';

const K_BUSINESS = '111111';
const SYNCED_AT = '2026-11-25T10:00:00.000Z';

/** Shapes from the live /v1/member/group/list?is_return_members=1 probe, 19 Nov 2026. */
const SDC = {
  id_member_group_shape: 3,
  k_member_group: '18454',
  text_color_background: '#ff007f',
  text_icon: 'SDC',
  text_title: 'SDC Clients',
  a_uid: ['32277096', '34064623'],
};
const EEDA = {
  id_member_group_shape: 3,
  k_member_group: '20512',
  text_icon: 'EED',
  text_title: 'EEDA',
  a_uid: ['32277096'],
};

const body = (list: unknown) => ({ a_member_group: list, status: 'ok' });
const response = (b: unknown): WlResponse<unknown> => ({
  body: b,
  traceId: 'mg.1',
  kLog: null,
  httpStatus: 200,
  latencyMs: 5,
});

describe('parseMemberGroupList', () => {
  it('maps groups and one member row per (group, uid), keys kept as text', () => {
    const { groups, members } = parseMemberGroupList(body([SDC, EEDA]), K_BUSINESS, SYNCED_AT);
    expect(groups).toEqual([
      {
        k_member_group: '18454',
        k_business: K_BUSINESS,
        title: 'SDC Clients',
        icon: 'SDC',
        synced_at: SYNCED_AT,
      },
      {
        k_member_group: '20512',
        k_business: K_BUSINESS,
        title: 'EEDA',
        icon: 'EED',
        synced_at: SYNCED_AT,
      },
    ]);
    expect(members.map((m) => `${m.k_member_group}:${m.uid}`)).toEqual([
      '18454:32277096',
      '18454:34064623',
      '20512:32277096',
    ]);
  });

  // WL sends this one as an ARRAY, unlike most list endpoints (CLAUDE.md).
  it('accepts a keyed object as well as an array', () => {
    const { groups } = parseMemberGroupList(body({ a: SDC, b: EEDA }), K_BUSINESS, SYNCED_AT);
    expect(groups).toHaveLength(2);
  });

  it('keeps a numeric key as text rather than dropping it', () => {
    const { groups, members } = parseMemberGroupList(
      body([{ ...EEDA, k_member_group: 20512, a_uid: [32277096] }]),
      K_BUSINESS,
      SYNCED_AT,
    );
    expect(groups[0]?.k_member_group).toBe('20512');
    expect(members[0]?.uid).toBe('32277096');
  });

  it('skips a group with no key or no title instead of storing a nameless row', () => {
    const { groups } = parseMemberGroupList(
      body([{ text_title: 'Keyless' }, { k_member_group: '1' }]),
      K_BUSINESS,
      SYNCED_AT,
    );
    expect(groups).toEqual([]);
  });

  it('deduplicates a repeated member, which an upsert batch would reject', () => {
    const { members } = parseMemberGroupList(
      body([{ ...EEDA, a_uid: ['32277096', '32277096'] }]),
      K_BUSINESS,
      SYNCED_AT,
    );
    expect(members).toHaveLength(1);
  });
});

describe('writeMemberGroupList', () => {
  function fakeDb() {
    const calls: Array<{ op: string; table: string; arg?: unknown }> = [];
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, arg: rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-mg' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], options?: { onConflict?: string }) => {
        calls.push({ op: 'upsert', table, arg: options?.onConflict });
        return Promise.resolve(rows);
      }),
      delete: vi.fn((table: string, query: string) => {
        calls.push({ op: 'delete', table, arg: query });
        return Promise.resolve();
      }),
    };
    return { db: db as unknown as SupabaseClient, calls };
  }

  const input = (b: unknown) => ({
    kBusiness: K_BUSINESS,
    response: response(b),
    runId: 'run-1',
    syncedAt: SYNCED_AT,
  });

  it('upserts groups and members on their natural keys', async () => {
    const { db, calls } = fakeDb();
    const result = await writeMemberGroupList(db, input(body([SDC, EEDA])));
    expect(result).toMatchObject({ groups: 2, members: 3 });
    expect(calls).toContainEqual({ op: 'upsert', table: 'member_group', arg: 'k_member_group' });
    expect(calls).toContainEqual({
      op: 'upsert',
      table: 'member_group_member',
      arg: 'k_member_group,uid',
    });
  });

  // WL holds current membership only. A student who left EEDA must not keep
  // EEDA as their FI on the next form, so whatever this run did not see goes.
  it('deletes rows older than this run - membership is replaced, not merged', async () => {
    const { db, calls } = fakeDb();
    await writeMemberGroupList(db, input(body([SDC])));
    const stale = `k_business=eq.${K_BUSINESS}&synced_at=lt.${encodeURIComponent(SYNCED_AT)}`;
    expect(calls).toContainEqual({ op: 'delete', table: 'member_group_member', arg: stale });
    expect(calls).toContainEqual({ op: 'delete', table: 'member_group', arg: stale });
  });

  // An empty list is likelier a WL hiccup than a studio with no groups. Acting
  // on it would wipe every student's FI and stop every sign-off.
  it('deletes NOTHING when WL returns no groups', async () => {
    const { db, calls } = fakeDb();
    const result = await writeMemberGroupList(db, input(body([])));
    expect(result.groups).toBe(0);
    expect(calls.filter((c) => c.op === 'delete')).toEqual([]);
    expect(calls.some((c) => c.table === 'raw_wl')).toBe(true);
  });
});
