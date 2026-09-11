import type { SupabaseClient } from '../supabase/client.js';
import type { WlResponse } from '../wl/client.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The receipt writer: /v1/purchase/receipt -> money on an existing purchase.
 *
 * Task 014 wrote the purchase and its items with money null; this fills it in,
 * one receipt per k_purchase. The receipt shape (probed live 2026-08-21, recorded
 * in WL-API-NOTES):
 *
 *   - a_price      -> the purchase totals, a keyed object: m_sum, m_discount,
 *                     m_tax, m_tip, m_total, text_currency.
 *   - a_customer   -> the payer as printed on the receipt: text_name, text_mail,
 *                     text_phone - WITHOUT a uid (see DATA-MODEL), so these columns
 *                     are the only record of who was billed when the payer is not
 *                     in person. (Shape per the WL Postman collection; a live
 *                     confirmation row is in task 008.)
 *   - a_purchase_item[] -> each item's m_price_total + text_currency (the royalty
 *                     figure - the item is what a teacher is paid on).
 *   - a_pay_method[]    -> the payment breakdown (purchase_payment).
 *   - a_account_rest[]  -> account-credit info (purchase_account_credit). A
 *                     negative m_amount is a BALANCE, not a payment - kept in its
 *                     own table so summing payments never misstates revenue.
 *
 * MONEY IS numeric(12,2) FROM WL'S STRING. WL sends "280.00"; it is stored as the
 * string and cast by Postgres - never parsed to a float, which would round.
 *
 * IDEMPOTENT: the purchase and its items are UPDATED in place; payment and credit
 * rows have no natural key, so they are deleted for this k_purchase and reinserted.
 */

export type PurchaseMoney = {
  readonly m_sum: string | null;
  readonly m_discount: string | null;
  readonly m_tax: string | null;
  readonly m_tip: string | null;
  readonly m_total: string | null;
  readonly text_currency: string | null;
  readonly text_purchase_id: string | null;
  readonly payer_name: string | null;
  readonly payer_email: string | null;
  readonly payer_phone: string | null;
};

export type ItemMoney = {
  readonly k_purchase_item: string;
  readonly k_purchase: string;
  readonly k_business: string;
  readonly m_price_total: string | null;
  readonly text_currency: string | null;
};

// Note: purchase_payment and purchase_account_credit have NO k_business column -
// they hang off k_purchase, which already carries the business.
export type PaymentRow = {
  readonly k_purchase: string;
  readonly text_pay_method: string;
  readonly m_amount: string;
  readonly text_currency: string | null;
};

export type CreditRow = {
  readonly k_purchase: string;
  readonly text_method: string | null;
  readonly m_amount: string;
  readonly text_currency: string | null;
};

export interface ParsedReceipt {
  /** Null when the receipt carried no a_price block. */
  readonly purchaseMoney: PurchaseMoney | null;
  readonly itemMoney: readonly ItemMoney[];
  readonly payments: readonly PaymentRow[];
  readonly credits: readonly CreditRow[];
}

export function parseReceipt(body: unknown, kPurchase: string, kBusiness: string): ParsedReceipt {
  const b = asRecord(body);
  const price = asRecord(b?.a_price);
  const customer = asRecord(b?.a_customer);
  const purchaseMoney: PurchaseMoney | null =
    price === null
      ? null
      : {
          m_sum: readString(price, 'm_sum'),
          m_discount: readString(price, 'm_discount'),
          m_tax: readString(price, 'm_tax'),
          m_tip: readString(price, 'm_tip'),
          m_total: readString(price, 'm_total'),
          text_currency: readString(price, 'text_currency'),
          text_purchase_id: readString(b, 'text_purchase_id'),
          payer_name: readString(customer, 'text_name'),
          payer_email: readString(customer, 'text_mail'),
          payer_phone: readString(customer, 'text_phone'),
        };

  const itemMoney: ItemMoney[] = [];
  for (const value of Object.values(asRecord(b?.a_purchase_item) ?? {})) {
    const rec = asRecord(value);
    // The receipt sends k_purchase_item as a NUMBER (the list sends a string); both
    // are the same text key, so coerce - a number read as a string would be lost.
    const kItem = readKey(rec, 'k_purchase_item');
    if (kItem === null) continue;
    itemMoney.push({
      k_purchase_item: kItem,
      k_purchase: kPurchase,
      k_business: kBusiness,
      m_price_total: readString(rec, 'm_price_total'),
      text_currency: readString(rec, 'text_currency'),
    });
  }

  const payments: PaymentRow[] = [];
  for (const value of Object.values(asRecord(b?.a_pay_method) ?? {})) {
    const rec = asRecord(value);
    const method = readString(rec, 'text_pay_method');
    const amount = readString(rec, 'm_amount');
    if (method === null || amount === null) continue; // both are NOT NULL columns
    payments.push({
      k_purchase: kPurchase,
      text_pay_method: method,
      m_amount: amount,
      text_currency: readString(rec, 'text_currency'),
    });
  }

  const credits: CreditRow[] = [];
  for (const value of Object.values(asRecord(b?.a_account_rest) ?? {})) {
    const rec = asRecord(value);
    const amount = readString(rec, 'm_amount');
    if (amount === null) continue; // m_amount is NOT NULL
    credits.push({
      k_purchase: kPurchase,
      text_method: readString(rec, 'text_method'),
      m_amount: amount,
      text_currency: readString(rec, 'text_currency'),
    });
  }

  return { purchaseMoney, itemMoney, payments, credits };
}

export interface WriteReceiptInput {
  readonly kBusiness: string;
  readonly kPurchase: string;
  readonly response: WlResponse<unknown>;
  readonly runId: string;
}

export interface WriteReceiptResult {
  readonly rawWlId: string;
  readonly itemsPriced: number;
  readonly payments: number;
  readonly credits: number;
}

export async function writeReceipt(
  db: SupabaseClient,
  input: WriteReceiptInput,
): Promise<WriteReceiptResult> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: '/v1/purchase/receipt',
    targetKind: 'record',
    targetKey: input.kPurchase,
    runId: input.runId,
    response: input.response,
  });

  const { purchaseMoney, itemMoney, payments, credits } = parseReceipt(
    input.response.body,
    input.kPurchase,
    input.kBusiness,
  );

  // Purchase totals: UPDATE the existing row, never insert.
  if (purchaseMoney !== null) {
    await db.update('purchase', { ...purchaseMoney }, `k_purchase=eq.${input.kPurchase}`);
    await linkRows(db, rawWlId, 'purchase', [input.kPurchase], 'money');
  }

  // Item prices: upsert on the item key. k_purchase/k_business are sent so the
  // (unreachable) insert path still satisfies NOT NULL; the real path updates
  // m_price_total on the row 014 already wrote.
  if (itemMoney.length > 0) {
    await db.upsert('purchase_item', itemMoney, { onConflict: 'k_purchase_item' });
    await linkRows(
      db,
      rawWlId,
      'purchase_item',
      itemMoney.map((i) => i.k_purchase_item),
      'money',
    );
  }

  // Payments and credits have no natural key: delete this purchase's rows, then
  // reinsert, so a re-run does not duplicate them.
  await db.delete('purchase_payment', `k_purchase=eq.${input.kPurchase}`);
  if (payments.length > 0) await db.insert('purchase_payment', payments);
  await db.delete('purchase_account_credit', `k_purchase=eq.${input.kPurchase}`);
  if (credits.length > 0) await db.insert('purchase_account_credit', credits);

  return {
    rawWlId,
    itemsPriced: itemMoney.length,
    payments: payments.length,
    credits: credits.length,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A WL key that may arrive as a string or a number; kept as text either way. */
function readKey(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
