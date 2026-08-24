import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The recipient writer: /v1/profile/purchase/list/element -> purchase.uid_recipient.
 *
 * Payer and recipient are different people (a parent buys lessons for a child -
 * see DATA-MODEL), and until now nothing populated uid_recipient: the purchase
 * list is per-payer by construction and the receipt's a_customer names only the
 * buyer, without a uid. The ELEMENT endpoint is the source (probed live
 * 24 Aug 2026, recorded in WL-API-NOTES): one call per k_purchase_item returns
 * `uid_recipient` / `s_recipient` (and `uid_payer` / `s_payer`, though uid_payer
 * is sometimes null where uid_recipient never was).
 *
 * WL's recipient is PER ITEM; our column is on `purchase` (0002). So:
 *
 *   - the first item to name a recipient fills purchase.uid_recipient;
 *   - a later item AGREEING is a no-op (idempotent re-run);
 *   - a later item DISAGREEING is parked as a sync_conflict - the case the 0007
 *     header anticipated - never silently overwritten.
 *
 * FK-safe by STUB: uid_recipient references person(uid), and the recipient may
 * not be someone we can enumerate yet (no client-list endpoint - STATUS blocker
 * 1). A person stub (uid + k_business only) is upserted first, the same
 * stub-don't-fail pattern locations and services use; a later client sync
 * enriches it, and the upsert never clobbers an already-enriched row because
 * PostgREST writes only the columns sent.
 */

export interface ParsedElement {
  /** Null when absent, empty, or WL's "0" nobody-placeholder. */
  readonly uidRecipient: string | null;
  readonly sRecipient: string | null;
  readonly uidPayer: string | null;
  readonly sPayer: string | null;
}

export function parsePurchaseElement(body: unknown): ParsedElement {
  const b = asRecord(body);
  return {
    uidRecipient: readUid(b, 'uid_recipient'),
    sRecipient: readString(b, 's_recipient'),
    uidPayer: readUid(b, 'uid_payer'),
    sPayer: readString(b, 's_payer'),
  };
}

export interface WriteRecipientInput {
  readonly kBusiness: string;
  readonly kPurchaseItem: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export interface WriteRecipientResult {
  readonly rawWlId: string;
  /** True when this call set purchase.uid_recipient (it was null before). */
  readonly recipientSet: boolean;
  /** True when a disagreement was parked in sync_conflict. */
  readonly conflict: boolean;
}

export async function writeRecipient(
  db: SupabaseClient,
  input: WriteRecipientInput,
): Promise<WriteRecipientResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/profile/purchase/list/element',
    targetKind: 'record',
    targetKey: input.kPurchaseItem,
    runId: input.runId,
    response: input.response,
  });

  const { uidRecipient } = parsePurchaseElement(input.response.body);
  if (uidRecipient === null) return { rawWlId, recipientSet: false, conflict: false };

  // The element does not echo k_purchase; the item row 014 wrote carries it.
  const items = await db.select<{ k_purchase: string }>(
    'purchase_item',
    `k_purchase_item=eq.${input.kPurchaseItem}&select=k_purchase`,
  );
  const kPurchase = items[0]?.k_purchase;
  if (kPurchase === undefined) return { rawWlId, recipientSet: false, conflict: false };

  const purchases = await db.select<{ uid_recipient: string | null }>(
    'purchase',
    `k_purchase=eq.${kPurchase}&select=uid_recipient`,
  );
  const existing = purchases[0]?.uid_recipient ?? null;

  // Same recipient again - a re-run, or a sibling item agreeing. Nothing to do.
  if (existing === uidRecipient) return { rawWlId, recipientSet: false, conflict: false };

  if (existing !== null) {
    // Two items of one purchase name DIFFERENT recipients. That is a human
    // decision (the column is per-purchase by design), so park it - never
    // overwrite. Guarded so a re-run does not file the same conflict twice.
    const open = await db.select<{ id: string }>(
      'sync_conflict',
      `table_name=eq.purchase&record_key=eq.${kPurchase}` +
        `&reason=eq.recipient-differs-by-item&resolution_state=eq.open&select=id`,
    );
    if (open.length === 0) {
      await db.insert('sync_conflict', [
        {
          k_business: input.kBusiness,
          table_name: 'purchase',
          record_key: kPurchase,
          reason: 'recipient-differs-by-item',
          detail: {
            existing_uid_recipient: existing,
            incoming_uid_recipient: uidRecipient,
            k_purchase_item: input.kPurchaseItem,
          },
          found_by_run_id: input.runId,
          trace_id: input.response.traceId,
        },
      ]);
    }
    return { rawWlId, recipientSet: false, conflict: true };
  }

  // Stub FIRST so the uid_recipient FK resolves (see the header).
  await db.upsert('person', [{ uid: uidRecipient, k_business: input.kBusiness }], {
    onConflict: 'uid',
  });
  await db.update('purchase', { uid_recipient: uidRecipient }, `k_purchase=eq.${kPurchase}`);
  await linkRows(db, rawWlId, 'purchase', [kPurchase], 'recipient');
  return { rawWlId, recipientSet: true, conflict: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * A uid that may arrive as a string or a number, with WL's "0" placeholder
 * (the same "nobody" convention as k_location "0") read as null.
 */
function readUid(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  const text =
    typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  return text.length === 0 || text === '0' ? null : text;
}
