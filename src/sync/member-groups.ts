import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The client-group writer: /v1/member/group/list -> member_group + member_group_member.
 *
 * WHY THIS EXISTS. This studio records a self-direction student's Fiscal
 * Intermediary as a WL client GROUP ("ISS", "AIM", "EEDA", "Self Pay"), not as a
 * profile field, and "SDC Clients" is the group that marks who needs a lesson
 * sign-off (task 038). Asked with `is_return_members=1`, one call returns every
 * group and its member uids - measured 19 Nov 2026: 28 groups, 216 SDC members.
 * The endpoint is NOT in WL's v1 docs; it is the SDK's GroupList ListModel.
 *
 * SHAPE, probed live: `a_member_group` is an ARRAY (most WL lists are keyed
 * objects - CLAUDE.md), each entry
 *   {"k_member_group":"<key>","text_title":"EEDA","text_icon":"EED",
 *    "a_uid":["<uid>", ...], "text_color_background":..., ...}
 * Both shapes are accepted.
 *
 * REPLACED, NOT MERGED. WL holds current membership only, so a member who left a
 * group must leave our table too, or their old FI keeps appearing on new forms.
 * Every row is stamped with this run's `syncedAt`, then anything older is deleted.
 *
 * AN EMPTY ANSWER DELETES NOTHING. A list with no groups is far likelier to be a
 * WL hiccup than a studio that deleted all 28 groups, and acting on it would wipe
 * every student's FI. The writer stores the raw response and stops.
 */

export type MemberGroupRow = {
  readonly k_member_group: string;
  readonly k_business: string;
  readonly title: string;
  readonly icon: string | null;
  readonly synced_at: string;
};

export type MemberGroupMemberRow = {
  readonly k_member_group: string;
  readonly uid: string;
  readonly k_business: string;
  readonly synced_at: string;
};

export interface ParsedMemberGroups {
  readonly groups: MemberGroupRow[];
  readonly members: MemberGroupMemberRow[];
}

export function parseMemberGroupList(
  body: unknown,
  kBusiness: string,
  syncedAt: string,
): ParsedMemberGroups {
  const groups = new Map<string, MemberGroupRow>();
  const members = new Map<string, MemberGroupMemberRow>();
  for (const value of collection(asRecord(body)?.a_member_group)) {
    const rec = asRecord(value);
    const key = readKey(rec?.k_member_group);
    const title = readString(rec, 'text_title');
    if (key === null || title === null) continue; // nothing we could name or key
    groups.set(key, {
      k_member_group: key,
      k_business: kBusiness,
      title,
      icon: readString(rec, 'text_icon'),
      synced_at: syncedAt,
    });
    for (const raw of collection(rec?.a_uid)) {
      const uid = readKey(raw);
      if (uid === null) continue;
      members.set(`${key}|${uid}`, {
        k_member_group: key,
        uid,
        k_business: kBusiness,
        synced_at: syncedAt,
      });
    }
  }
  return { groups: [...groups.values()], members: [...members.values()] };
}

export interface WriteMemberGroupsInput {
  readonly kBusiness: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
  /** This run's timestamp. Rows older than it are what the replace deletes. */
  readonly syncedAt: string;
}

export interface WriteMemberGroupsResult {
  readonly rawWlId: string;
  readonly groups: number;
  readonly members: number;
}

export async function writeMemberGroupList(
  db: SupabaseClient,
  input: WriteMemberGroupsInput,
): Promise<WriteMemberGroupsResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/member/group/list',
    targetKind: 'whole',
    targetKey: 'all',
    runId: input.runId,
    response: input.response,
  });

  const { groups, members } = parseMemberGroupList(
    input.response.body,
    input.kBusiness,
    input.syncedAt,
  );
  if (groups.length === 0) return { rawWlId, groups: 0, members: 0 };

  await db.upsert('member_group', groups, { onConflict: 'k_member_group' });
  if (members.length > 0) {
    await db.upsert('member_group_member', members, { onConflict: 'k_member_group,uid' });
  }

  // The replace. Members first: deleting a group cascades to its members, but a
  // member who merely left a group that still exists is only caught here.
  const stale = `k_business=eq.${input.kBusiness}&synced_at=lt.${encodeURIComponent(input.syncedAt)}`;
  await db.delete('member_group_member', stale);
  await db.delete('member_group', stale);

  await linkRows(
    db,
    rawWlId,
    'member_group',
    groups.map((g) => g.k_member_group),
  );
  return { rawWlId, groups: groups.length, members: members.length };
}

/** WL sends this list as an ARRAY, but accept a keyed object too (see writer.ts). */
function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  return rec === null ? [] : Object.values(rec);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** WL keys arrive as strings; a number is accepted and kept as text (CLAUDE.md). */
function readKey(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return null;
}
