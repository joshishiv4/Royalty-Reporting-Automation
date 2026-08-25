import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows } from './writer.js';

/**
 * The membership writer: /v1/profile/purchase/list/element -> purchase_item
 * membership state and refund (PRD 6.2, task 023).
 *
 * NOT FROM THE PURCHASE LIST. The board wording says these fields come from
 * /v1/profile/purchase/list; probed live 24 Aug 2026 over 109 items, that
 * endpoint returns eighteen fields and not one of them is a membership or refund
 * field. Every field here is on the ELEMENT endpoint - which the element pass
 * already calls once per purchase item for the recipient (task 021) and from
 * which it kept four fields out of eighty-seven. So this costs no extra call.
 *
 * SHARES THE RAW ROW. writeRecipient has already stored the payload by the time
 * this runs, and the caller passes its `rawWlId` in. One payload, one raw_wl row,
 * two typed writes - storing it twice would double raw_wl for no new evidence.
 *
 * MERGE, NEVER CLOBBER - the same rule as the profile writer. WL sends "" for a
 * field it has nothing for; that is read as null and OMITTED from the upsert, so
 * a PostgREST upsert (which writes only the columns present) cannot blank a value
 * another source set. Booleans are different: WL always sends true/false, so
 * `false` is an answer, not an absence, and is always written.
 *
 * SESSION COUNTS (PRD 6.4) ride on this same payload - i_limit, i_left, i_remain,
 * i_use, i_book, i_buy - so they cost no extra call. Q14 asked why they seemed to
 * contradict each other: they never did. i_left is 0 on 109 of 109 items and is
 * simply not the remaining count; i_limit - i_use = i_remain held on 6 of 6
 * limited items. Nothing is reconciled in code - the raw values are stored and
 * the arithmetic is left to whoever reads them, exactly as the ticket asked.
 *
 * REFRESH, NOT FILL-ONLY. Membership state changes - a hold starts, a
 * cancellation goes pending, a renewal counter ticks. Upsert on k_purchase_item
 * updates in place, so a re-run refreshes and never duplicates.
 */

export type MembershipRow = {
  readonly k_purchase_item: string;
  readonly k_purchase: string;
  readonly k_business: string;
  /** Always written: WL sends a real boolean, so false is an answer. */
  readonly is_hold: boolean;
  readonly is_cancel_pending: boolean;
  readonly is_renew: boolean;
  readonly sid_value?: string;
  readonly i_payment_period?: number;
  readonly m_period_price?: string;
  readonly dt_hold_start?: string;
  readonly dt_hold_end?: string;
  readonly dt_cancel?: string;
  readonly i_renew?: number;
  readonly m_refund?: string;
  // Session counts (PRD 6.4). Stored as WL sends them, never arithmetic.
  readonly i_limit?: number;
  readonly i_left?: number;
  readonly i_remain?: number;
  readonly i_use?: number;
  readonly i_book?: number;
  readonly i_buy?: number;
};

/**
 * Parses an element payload into a `purchase_item` patch.
 *
 * `kPurchase` is required because the element body does NOT echo it (the same
 * gap the recipient writer works around); the caller reads it off the item row
 * that task 014 wrote. It is carried on the patch so the upsert satisfies
 * purchase_item.k_purchase NOT NULL if the row somehow does not exist yet.
 */
export function parseMembership(
  body: unknown,
  kPurchaseItem: string,
  kPurchase: string,
  kBusiness: string,
): MembershipRow {
  const b = asRecord(body);
  const row: Record<string, unknown> = {
    k_purchase_item: kPurchaseItem,
    k_purchase: kPurchase,
    k_business: kBusiness,
    is_hold: wlBool(b?.is_hold),
    is_cancel_pending: wlBool(b?.is_cancel_pending),
    is_renew: wlBool(b?.is_renew),
  };
  const put = (col: string, value: unknown): void => {
    if (value !== null) row[col] = value;
  };

  put('sid_value', readString(b, 'sid_value'));
  put('i_payment_period', readInt(b?.i_payment_period));
  put('m_period_price', readMoney(b?.m_period_price));
  put('dt_hold_start', readString(b, 'dt_hold_start'));
  put('dt_hold_end', readString(b, 'dt_hold_end'));
  put('dt_cancel', readString(b, 'dt_cancel'));
  put('i_renew', readInt(b?.i_renew));
  put('m_refund', readRefund(b?.m_refund));

  // Session counts. readCount, NOT readInt: zero is a real answer here - "0
  // sessions remaining" is the difference between a usable package and a spent
  // one, and readInt drops zeros on purpose for the membership-term fields.
  put('i_limit', readCount(b?.i_limit));
  put('i_left', readCount(b?.i_left));
  put('i_remain', readCount(b?.i_remain));
  put('i_use', readCount(b?.i_use));
  put('i_book', readCount(b?.i_book));
  put('i_buy', readCount(b?.i_buy));

  return row as unknown as MembershipRow;
}

export interface WriteMembershipInput {
  readonly kBusiness: string;
  readonly kPurchaseItem: string;
  readonly response: WlResponse<unknown>;
  /** The raw_wl row the recipient write already stored for this payload. */
  readonly rawWlId: string;
}

export interface WriteMembershipResult {
  /** False when the purchase item is not in the database (nothing to patch). */
  readonly written: boolean;
  /** True when this item carries membership terms, not just an appointment. */
  readonly isMembership: boolean;
  /** How many optional columns WL actually filled, beyond the always-written flags. */
  readonly fieldsFilled: number;
}

export async function writeMembership(
  db: SupabaseClient,
  input: WriteMembershipInput,
): Promise<WriteMembershipResult> {
  // The element does not echo k_purchase; the item row 014 wrote carries it.
  // Without it the upsert could insert a purchase_item violating NOT NULL, so an
  // unknown item is skipped rather than guessed at.
  const items = await db.select<{ k_purchase: string }>(
    'purchase_item',
    `k_purchase_item=eq.${input.kPurchaseItem}&select=k_purchase`,
  );
  const kPurchase = items[0]?.k_purchase;
  if (kPurchase === undefined) return { written: false, isMembership: false, fieldsFilled: 0 };

  const row = parseMembership(input.response.body, input.kPurchaseItem, kPurchase, input.kBusiness);

  // Six anchors/flags are always present; the rest is what WL actually filled.
  const fieldsFilled = Object.keys(row).length - 6;

  await db.upsert('purchase_item', [row], { onConflict: 'k_purchase_item' });
  await linkRows(db, input.rawWlId, 'purchase_item', [input.kPurchaseItem], 'membership');

  return {
    written: true,
    isMembership: row.sid_value !== undefined && row.sid_value !== 'appointment',
    fieldsFilled,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** WL sends "" for a field it has nothing for; read it as null so it is omitted. */
function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function wlBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/**
 * An integer counter. WL may send it as a number or a numeric string. Zero is
 * read as null: WL uses 0 for "no payment period" / "never renewed", and storing
 * it would claim a membership term the item does not have.
 */
function readInt(value: unknown): number | null {
  let n: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) n = Math.trunc(value);
  else if (typeof value === 'string' && /^-?\d+$/.test(value)) n = Number.parseInt(value, 10);
  return n === null || n === 0 ? null : n;
}

/**
 * A session count. Unlike readInt, ZERO IS KEPT: a package with i_remain 0 is
 * spent, which is a fact worth storing, while readInt's zero-means-absent rule
 * exists for membership terms where 0 means "no such term". Same payload, two
 * different meanings for the same number - so two readers.
 */
function readCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/**
 * Money as WL sends it - a string, kept a string so numeric(12,2) parses it
 * exactly. "" is null; "0.00" is a real zero price and is KEPT (eight items
 * carry one live, and a zero-priced period is not the same as no period).
 */
function readMoney(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value !== 'string' || value.length === 0) return null;
  return /^-?\d+(\.\d+)?$/.test(value) ? value : null;
}

/**
 * The refund, which needs its own reader: WL's no-refund marker is the string
 * "0" (not "0.00", not ""), and a real refund arrives NEGATIVE. Reading "0" as
 * null keeps "never refunded" distinguishable from "refunded zero".
 */
function readRefund(value: unknown): string | null {
  const money = readMoney(value);
  if (money === null) return null;
  return Number.parseFloat(money) === 0 ? null : money;
}
