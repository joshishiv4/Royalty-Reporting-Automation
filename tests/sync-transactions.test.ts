import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import {
  assertTransactionFields,
  mapTransactionRows,
  transactionTable,
  writeTransactionPage,
} from '../src/sync/transactions.js';

/**
 * Mapping a transaction report row.
 *
 * Two properties carry the weight here. Values are read by field NAME, because
 * report columns are configured per business in the WL portal and reading by
 * index puts a tax value in a tip column the first time somebody reorders them.
 * And a row's identity is a HASH of what is stored, because WL publishes no
 * unique key for either report - `k_pay_transaction` is null on 10,838 of
 * 10,913 item rows, and every key it does publish collapses a sale together
 * with its later refund.
 */

const K = '334942';

/** The item view's mapped columns, in the order the live report returns them. */
const ITEM_FIELDS = [
  'k_pay_transaction',
  'k_purchase',
  'k_purchase_item',
  'k_id',
  'id_table',
  'id_purchase_item',
  'k_promotion',
  'o_date.dtu_date',
  'o_date.dtl_date',
  'o_client.uid_client',
  'o_location.k_location',
  'text_revenue_category',
  'i_quantity',
  'm_amount',
  'm_sale',
  'm_net_sale',
  'm_discount_amount',
  'm_total_tax',
  'm_total_tip',
  'm_total_amount',
  'm_total_paid',
  'm_total_receipt',
  'm_debit',
  'm_credit',
  'm_account_change',
  'm_transaction_balance',
  'text_discount_code',
  'text_payment_method',
  'text_payment_method_base',
  'text_origin',
  'text_frequency',
  's_batch_number',
  'id_pay_transaction_status',
  'id_currency',
  'o_actor.uid_actor',
  'o_actor.text_actor',
  'o_action.is_refund_transaction',
  'o_purchase_item_title_link.a_item',
];

/** A sale, as the live report returned one. */
function itemRow(over: Partial<Record<string, unknown>> = {}): unknown[] {
  const values: Record<string, unknown> = {
    k_pay_transaction: null,
    k_purchase: '180910254',
    k_purchase_item: '190119840',
    k_id: '48091850',
    id_table: 251,
    id_purchase_item: 3,
    k_promotion: '2955192',
    'o_date.dtu_date': '2025-10-01 06:17:22',
    'o_date.dtl_date': '2025-10-01 02:17:22',
    'o_client.uid_client': '36453766',
    'o_location.k_location': '244238',
    text_revenue_category: 'Monthly Subscriptions',
    i_quantity: 1,
    m_amount: '239.00',
    m_sale: '239.0000',
    m_net_sale: '239.00',
    m_discount_amount: null,
    m_total_tax: '0.0000',
    m_total_tip: null,
    m_total_amount: '239.00',
    m_total_paid: '239.00',
    m_total_receipt: '239.00',
    m_debit: null,
    m_credit: null,
    m_account_change: null,
    m_transaction_balance: '0.00',
    text_discount_code: '',
    text_payment_method: 'Virtual Terminal (Mastercard ****-9189)',
    text_payment_method_base: 'Virtual Terminal',
    text_origin: 'Automatic payment',
    text_frequency: 'Recurring',
    s_batch_number: '',
    id_pay_transaction_status: 2,
    id_currency: 1,
    'o_actor.uid_actor': null,
    'o_actor.text_actor': 'System',
    'o_action.is_refund_transaction': false,
    'o_purchase_item_title_link.a_item': [
      { text_title: 'Monthly Subscription - 45 Minutes', k_purchase_item: '190119840' },
    ],
    ...over,
  };
  return ITEM_FIELDS.map((f) => values[f]);
}

describe('mapping an item-view row', () => {
  it('reads every value by field name and keeps money as the string WL sent', () => {
    const [row] = mapTransactionRows('item', ITEM_FIELDS, [itemRow()]);
    expect(row).toBeDefined();
    expect(row!.k_purchase_item).toBe('190119840');
    expect(row!.text_revenue_category).toBe('Monthly Subscriptions');
    expect(row!.item_title).toBe('Monthly Subscription - 45 Minutes');
    // A string, not a number: parsing it here would put money through a float,
    // which is exactly what numeric(12,2) exists to avoid.
    expect(row!.m_amount).toBe('239.00');
    expect(row!.m_sale).toBe('239.0000');
    expect(row!.i_quantity).toBe(1);
    expect(row!.id_table).toBe(251);
    expect(row!.is_refund).toBe(false);
  });

  /**
   * The failure this rules out: somebody adds a column in the WL portal, every
   * index shifts by one, and tax lands in the tip column with no error at all.
   */
  it('is unaffected by a column being inserted ahead of the ones it reads', () => {
    const shifted = ['field-custom-999', ...ITEM_FIELDS];
    const [baseline] = mapTransactionRows('item', ITEM_FIELDS, [itemRow()]);
    const [after] = mapTransactionRows('item', shifted, [['ignored', ...itemRow()]]);
    expect(after!.m_amount).toBe(baseline!.m_amount);
    expect(after!.row_hash).toBe(baseline!.row_hash);
  });

  it('keeps a key as text and drops WL"s "0" placeholder for no location', () => {
    const [row] = mapTransactionRows('item', ITEM_FIELDS, [
      itemRow({ 'o_location.k_location': '0', k_purchase: '0180910254' }),
    ]);
    expect(row!.k_location).toBeNull();
    // A leading zero is lost as a number - the house rule for every WL key.
    expect(row!.k_purchase).toBe('0180910254');
  });

  it('strips the NUL byte WL pads its sort values with', () => {
    const [row] = mapTransactionRows('item', ITEM_FIELDS, [
      itemRow({ text_revenue_category: 'Monthly Subscriptions\u0000' }),
    ]);
    // Postgres rejects a NUL inside text outright, so this is the difference
    // between a stored row and a failed pass.
    expect(row!.text_revenue_category).toBe('Monthly Subscriptions');
  });
});

describe('row identity', () => {
  /** Re-reading the same report has to be an upsert, never a second copy. */
  it('gives the same row the same hash on a re-read', () => {
    const first = mapTransactionRows('item', ITEM_FIELDS, [itemRow()]);
    const second = mapTransactionRows('item', ITEM_FIELDS, [itemRow()]);
    expect(second[0]!.row_hash).toBe(first[0]!.row_hash);
    expect(second[0]!.i_occurrence).toBe(0);
  });

  /**
   * THE MEASURED CASE. A sale and its later refund share the item key and differ
   * in sign and date: 166 such pairs live. Any natural key built from WL's own
   * columns collapses them into one row and loses the refund.
   */
  it('separates a sale from its refund, which share every key WL publishes', () => {
    const sale = itemRow();
    const refund = itemRow({
      i_quantity: -1,
      m_amount: '-239.00',
      m_net_sale: '-239.00',
      m_total_amount: '-239.00',
      'o_date.dtu_date': '2025-11-13 19:36:11',
      'o_date.dtl_date': '2025-11-13 14:36:11',
      'o_action.is_refund_transaction': true,
    });
    const rows = mapTransactionRows('item', ITEM_FIELDS, [sale, refund]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.row_hash).not.toBe(rows[1]!.row_hash);
    expect(rows[1]!.is_refund).toBe(true);
  });

  /**
   * Twelve repeat groups in the live item report differ in NOTHING but the
   * title. Dropping item_title from the hash would merge each pair.
   */
  it('separates two rows that differ only in the item title', () => {
    const credit = itemRow({
      'o_purchase_item_title_link.a_item': [{ text_title: 'General credit' }],
    });
    const payment = itemRow({
      'o_purchase_item_title_link.a_item': [{ text_title: 'Account Payment' }],
    });
    const rows = mapTransactionRows('item', ITEM_FIELDS, [credit, payment]);
    expect(rows[0]!.row_hash).not.toBe(rows[1]!.row_hash);
  });

  /**
   * 649 rows of the payment report are byte-identical to another row across all
   * 140 fields. Nothing can tell them apart, so they are NUMBERED rather than
   * collapsed - collapsing would quietly drop 649 payments from a revenue total.
   */
  it('numbers indistinguishable rows instead of collapsing them', () => {
    const rows = mapTransactionRows('item', ITEM_FIELDS, [itemRow(), itemRow(), itemRow()]);
    expect(rows.map((r) => r.i_occurrence)).toEqual([0, 1, 2]);
    expect(new Set(rows.map((r) => r.row_hash)).size).toBe(1);
  });

  /**
   * Half the repeat groups are NOT adjacent in report order, so the counter has
   * to be shared across pages. A per-page counter would number the second copy
   * 0 again and the write would merge it into the first.
   */
  it('continues the count across pages when the caller shares the map', () => {
    const seen = new Map<string, number>();
    const page1 = mapTransactionRows('item', ITEM_FIELDS, [itemRow()], seen);
    const page2 = mapTransactionRows('item', ITEM_FIELDS, [itemRow()], seen);
    expect(page1[0]!.i_occurrence).toBe(0);
    expect(page2[0]!.i_occurrence).toBe(1);
  });
});

describe('assertTransactionFields', () => {
  it('accepts the live field list', () => {
    expect(() => assertTransactionFields('item', ITEM_FIELDS)).not.toThrow();
  });

  /**
   * A mapper that reads by name skips an id it does not recognise - right for
   * the hundred columns we ignore, silent for a column we need. Without this
   * guard, a column removed in the WL portal stops being written and the pass
   * still reports ok.
   */
  it('refuses a page that has lost a column this sync maps', () => {
    const missing = ITEM_FIELDS.filter((f) => f !== 'text_revenue_category');
    expect(() => assertTransactionFields('item', missing)).toThrow(/text_revenue_category/);
  });
});

describe('writeTransactionPage', () => {
  function harness() {
    const upserts: Array<{ table: string; rows: Array<Record<string, unknown>>; opts?: unknown }> =
      [];
    const insert = vi.fn((table: string, rows: unknown[]) =>
      Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-1' }] : rows),
    );
    const db = {
      insert,
      upsert: vi.fn((table: string, rows: Array<Record<string, unknown>>, opts: unknown) => {
        upserts.push({ table, rows, opts });
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;
    return { db, upserts, insert };
  }

  const page = {
    fields: ITEM_FIELDS,
    rows: [itemRow()],
    response: { body: {}, httpStatus: 200, traceId: 't', kLog: null, latencyMs: 1 },
  } as never;

  it('stubs the person and location the FKs need BEFORE writing the row', async () => {
    const { db, upserts } = harness();
    await writeTransactionPage(db, {
      kBusiness: K,
      runId: 'r1',
      report: 'item',
      page,
      fields: ITEM_FIELDS,
      syncedAt: '2026-09-17T00:00:00.000Z',
      seen: new Map(),
    });
    expect(upserts.map((u) => u.table)).toEqual(['person', 'location', 'pay_transaction_item']);
    // A stub is the key and the business only, so a later profile sync fills the
    // name and email and this never overwrites them.
    expect(upserts[0]!.rows[0]).toEqual({ uid: '36453766', k_business: K });
  });

  it('upserts on the natural key, so a re-read updates rather than duplicates', async () => {
    const { db, upserts } = harness();
    await writeTransactionPage(db, {
      kBusiness: K,
      runId: 'r1',
      report: 'item',
      page,
      fields: ITEM_FIELDS,
      syncedAt: '2026-09-17T00:00:00.000Z',
      seen: new Map(),
    });
    const written = upserts.find((u) => u.table === transactionTable('item'));
    expect(written!.opts).toEqual({ onConflict: 'k_business,row_hash,i_occurrence' });
  });

  /**
   * The raw payload is stored FIRST, so a report whose shape has changed can be
   * re-read from raw_wl without a second WellnessLiving call.
   */
  it('stores the payload before refusing a page with a missing column', async () => {
    const { db, insert } = harness();
    await expect(
      writeTransactionPage(db, {
        kBusiness: K,
        runId: 'r1',
        report: 'item',
        page,
        fields: ITEM_FIELDS.filter((f) => f !== 'm_amount'),
        syncedAt: '2026-09-17T00:00:00.000Z',
        seen: new Map(),
      }),
    ).rejects.toThrow(/m_amount/);
    expect(insert).toHaveBeenCalledWith('raw_wl', expect.anything());
  });
});
