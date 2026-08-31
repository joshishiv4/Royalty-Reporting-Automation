import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseReceipt, writeReceipt } from '../src/sync/receipts.js';

const K_BUSINESS = '111111';
const K_PURCHASE = '143051';

function receiptBody(): unknown {
  return {
    text_purchase_id: '000000143051',
    a_price: {
      m_sum: '280.00',
      m_discount: '0.00',
      m_tax: '0.00',
      m_tip: '0.00',
      m_total: '280.00',
      text_currency: 'usd',
    },
    a_customer: {
      text_name: 'Pat Parent',
      text_mail: 'pat@example.com',
      text_phone: '+1 555 0100',
      text_address: '1 Main St', // printed on the receipt, not a stored column
    },
    a_purchase_item: {
      '0': { k_purchase_item: 'item-1', m_price_total: '280.00', text_currency: 'usd' },
    },
    a_pay_method: {
      '0': { text_pay_method: 'Account', m_amount: '280.00', text_currency: 'usd' },
      '1': { m_amount: '5.00' }, // no method: skipped (NOT NULL column)
    },
    a_account_rest: {
      '0': { text_method: 'Account Balance', m_amount: '-700.00', text_currency: 'usd' },
    },
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'r.1', kLog: null, httpStatus: 200, latencyMs: 9 };
}

describe('parseReceipt', () => {
  it('maps a_price to purchase money as strings, never floats', () => {
    const { purchaseMoney } = parseReceipt(receiptBody(), K_PURCHASE, K_BUSINESS);
    expect(purchaseMoney).toEqual({
      m_sum: '280.00',
      m_discount: '0.00',
      m_tax: '0.00',
      m_tip: '0.00',
      m_total: '280.00',
      text_currency: 'usd',
      text_purchase_id: '000000143051',
      payer_name: 'Pat Parent',
      payer_email: 'pat@example.com',
      payer_phone: '+1 555 0100',
    });
  });

  it('leaves payer fields null when the receipt carries no a_customer', () => {
    const { purchaseMoney } = parseReceipt(
      { a_price: { m_total: '10.00' } },
      K_PURCHASE,
      K_BUSINESS,
    );
    expect(purchaseMoney).toMatchObject({
      m_total: '10.00',
      payer_name: null,
      payer_email: null,
      payer_phone: null,
    });
  });

  it('maps item prices, payment methods and account credit', () => {
    const { itemMoney, payments, credits } = parseReceipt(receiptBody(), K_PURCHASE, K_BUSINESS);
    expect(itemMoney).toEqual([
      {
        k_purchase_item: 'item-1',
        k_purchase: K_PURCHASE,
        k_business: K_BUSINESS,
        m_price_total: '280.00',
        text_currency: 'usd',
      },
    ]);
    // The malformed pay method (no text_pay_method) is dropped.
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ text_pay_method: 'Account', m_amount: '280.00' });
    // A negative balance is a credit, kept out of payments.
    expect(credits[0]).toMatchObject({ text_method: 'Account Balance', m_amount: '-700.00' });
  });

  it('coerces a numeric k_purchase_item to text (the receipt sends a number)', () => {
    const body = {
      a_purchase_item: { '0': { k_purchase_item: 142604, m_price_total: '99.00' } },
    };
    const { itemMoney } = parseReceipt(body, K_PURCHASE, K_BUSINESS);
    expect(itemMoney).toHaveLength(1);
    expect(itemMoney[0]!.k_purchase_item).toBe('142604'); // string, matches the list key
  });

  it('sums a mixed payment breakdown to the total, exact to the cent', () => {
    // These amounts are a float trap: 120.10 + 39.20 + 120.70 in IEEE doubles is
    // 279.99999999999994, not 280. Summing in integer cents (never parseFloat
    // addition) must land on the total EXACTLY - the guarantee royalty maths
    // relies on.
    const body = {
      a_price: { m_total: '280.00', text_currency: 'usd' },
      a_pay_method: {
        '0': { text_pay_method: 'Visa', m_amount: '120.10', text_currency: 'usd' },
        '1': { text_pay_method: 'Cash', m_amount: '39.20', text_currency: 'usd' },
        '2': { text_pay_method: 'Account', m_amount: '120.70', text_currency: 'usd' },
      },
    };
    const { purchaseMoney, payments } = parseReceipt(body, K_PURCHASE, K_BUSINESS);

    // Exact decimal cents from the stored string - no floating point anywhere.
    const cents = (s: string): number => {
      const m = /^(-?)(\d+)\.(\d{2})$/.exec(s);
      if (m === null) throw new Error(`not a money string: ${s}`);
      return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
    };

    const paid = payments.reduce((sum, p) => sum + cents(p.m_amount), 0);
    expect(paid).toBe(cents(purchaseMoney!.m_total!)); // 28000 === 28000
    // And the parser passed every amount through untouched - no reformatting.
    expect(payments.map((p) => p.m_amount)).toEqual(['120.10', '39.20', '120.70']);
  });

  it('returns null purchase money and empty lists for a bare body', () => {
    const parsed = parseReceipt({}, K_PURCHASE, K_BUSINESS);
    expect(parsed.purchaseMoney).toBeNull();
    expect(parsed.itemMoney).toEqual([]);
    expect(parsed.payments).toEqual([]);
  });
});

describe('writeReceipt', () => {
  function fakeDb() {
    const calls: Array<{ op: string; table: string; query?: string; rows?: unknown[] }> = [];
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-r' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'upsert', table, rows });
        return Promise.resolve(rows);
      }),
      update: vi.fn((table: string, _p: unknown, query: string) => {
        calls.push({ op: 'update', table, query });
        return Promise.resolve([]);
      }),
      delete: vi.fn((table: string, query: string) => {
        calls.push({ op: 'delete', table, query });
        return Promise.resolve();
      }),
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  it('updates the purchase, upserts item money, and replaces payments/credits', async () => {
    const { db, calls } = fakeDb();

    const result = await writeReceipt(db, {
      kBusiness: K_BUSINESS,
      kPurchase: K_PURCHASE,
      response: response(receiptBody()),
      runId: 'run',
    });

    const seq = calls.map((c) => `${c.op}:${c.table}`);
    expect(seq).toEqual([
      'insert:raw_wl',
      'update:purchase',
      'insert:raw_link',
      'upsert:purchase_item',
      'insert:raw_link',
      'delete:purchase_payment',
      'insert:purchase_payment',
      'delete:purchase_account_credit',
      'insert:purchase_account_credit',
    ]);
    // Idempotent: payments are deleted for this purchase before being reinserted.
    expect(calls.find((c) => c.op === 'delete' && c.table === 'purchase_payment')!.query).toBe(
      `k_purchase=eq.${K_PURCHASE}`,
    );
    expect(result).toMatchObject({ itemsPriced: 1, payments: 1, credits: 1 });
  });

  it('still deletes stale payments even when the receipt has none', async () => {
    const { db, calls } = fakeDb();
    await writeReceipt(db, {
      kBusiness: K_BUSINESS,
      kPurchase: K_PURCHASE,
      response: response({ a_price: { m_total: '0.00' } }),
      runId: 'run',
    });
    // No a_pay_method, but the delete still runs so an old payment cannot linger.
    expect(calls.some((c) => c.op === 'delete' && c.table === 'purchase_payment')).toBe(true);
    expect(calls.some((c) => c.op === 'insert' && c.table === 'purchase_payment')).toBe(false);
  });
});
