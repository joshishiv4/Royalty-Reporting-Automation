import { createHash } from 'node:crypto';
import type { SupabaseClient } from '../supabase/client.js';
import type { ReportPage } from '../wl/report.js';
import { WL_PATHS } from '../wl/endpoint.js';
import { linkRows, storeRawWl } from './writer.js';

/**
 * The two transaction reports, and how a positional report row becomes a row in
 * `pay_transaction` / `pay_transaction_item`.
 *
 *   cid 739  "All Transactions (Item View)"     -> pay_transaction_item
 *   cid 799  "All Transactions (Payment View)"  -> pay_transaction
 *
 * WHY THESE ARE READ AT ALL, when purchases and receipts are already synced:
 * they are business-wide in two calls instead of one call per client, they carry
 * the revenue category, the batch and processor references and the actor, and a
 * refund arrives as its own dated row. What they do NOT carry is every purchase
 * item - only the ones money touched (10,913 of 20,561). Migration 0038's header
 * has the measurements and the reasoning.
 *
 * ROWS ARE POSITIONAL, AND NOTHING HERE READS BY INDEX. `a_row` holds bare
 * arrays and the column ids live separately in `a_field`. Report columns are
 * configured per business in the WL portal, so reading `row[9]` because the
 * amount sits there today is how a tax value ends up in a tip column the first
 * time somebody reorders the report. Every value is looked up by field NAME -
 * the same rule clients.ts follows for cid 689, for the same reason.
 *
 * MONEY ARRIVES AS A STRING, sometimes with four decimals ("239.0000"), and
 * negative for a refund ("-500.00"). It is passed through as the string WL sent
 * and cast by Postgres into numeric(12,2). Never parsed to a float here: a
 * float is exactly what the house rule forbids, and JSON.parse has already done
 * the only rounding we cannot prevent.
 */

/** Which report a page came from. Decides the field map and the target table. */
export type TransactionReport = 'item' | 'payment';

/**
 * Report field id -> column, per report.
 *
 * The keys are WL's own ids, verbatim, including the dotted paths into its
 * nested objects (`o_client.uid_client` is a real field id in `a_field`, not a
 * path this code walks).
 */
const ITEM_FIELDS: Readonly<Record<string, string>> = {
  k_pay_transaction: 'k_pay_transaction',
  k_purchase: 'k_purchase',
  k_purchase_item: 'k_purchase_item',
  k_id: 'k_id',
  id_table: 'id_table',
  id_purchase_item: 'id_purchase_item',
  k_promotion: 'k_promotion',
  'o_date.dtu_date': 'dtu_date',
  'o_date.dtl_date': 'dtl_date',
  'o_client.uid_client': 'uid_client',
  'o_location.k_location': 'k_location',
  text_revenue_category: 'text_revenue_category',
  i_quantity: 'i_quantity',
  m_amount: 'm_amount',
  m_sale: 'm_sale',
  m_net_sale: 'm_net_sale',
  m_discount_amount: 'm_discount_amount',
  m_total_tax: 'm_total_tax',
  m_total_tip: 'm_total_tip',
  m_total_amount: 'm_total_amount',
  m_total_paid: 'm_total_paid',
  m_total_receipt: 'm_total_receipt',
  m_debit: 'm_debit',
  m_credit: 'm_credit',
  m_account_change: 'm_account_change',
  m_transaction_balance: 'm_transaction_balance',
  text_discount_code: 'text_discount_code',
  text_payment_method: 'text_payment_method',
  text_payment_method_base: 'text_payment_method_base',
  text_origin: 'text_origin',
  text_frequency: 'text_frequency',
  s_batch_number: 's_batch_number',
  id_pay_transaction_status: 'id_pay_transaction_status',
  id_currency: 'id_currency',
  'o_actor.uid_actor': 'uid_actor',
  'o_actor.text_actor': 'text_actor',
};

const PAYMENT_FIELDS: Readonly<Record<string, string>> = {
  k_pay_transaction: 'k_pay_transaction',
  k_purchase: 'k_purchase',
  'o_date.dtu_date': 'dtu_date',
  'o_date.dtl_date': 'dtl_date',
  dtu_purchase_start: 'dtu_purchase_start',
  'o_client.uid_client': 'uid_client',
  'o_location.k_location': 'k_location',
  is_paid: 'is_paid',
  i_quantity: 'i_quantity',
  m_amount: 'm_amount',
  m_sale: 'm_sale',
  m_net_sale: 'm_net_sale',
  m_discount_amount: 'm_discount_amount',
  m_total_tax: 'm_total_tax',
  m_total_tip: 'm_total_tip',
  m_total_sale_amount: 'm_total_sale_amount',
  m_total_amount: 'm_total_amount',
  m_total_paid: 'm_total_paid',
  m_total_receipt: 'm_total_receipt',
  m_debit: 'm_debit',
  m_credit: 'm_credit',
  m_account_change: 'm_account_change',
  m_transaction_balance: 'm_transaction_balance',
  text_payment_method: 'text_payment_method',
  'o_payment_method.text_method': 'text_method',
  text_comment: 'text_comment',
  text_origin: 'text_origin',
  text_frequency: 'text_frequency',
  'o_payment_status.text_status': 'text_status',
  'o_decline_reason.text_decline_reason': 'text_decline_reason',
  s_batch_number: 's_batch_number',
  text_order_id: 'text_order_id',
  text_processor_reference: 'text_processor_reference',
  id_pay_transaction_status: 'id_pay_transaction_status',
  'o_actor.uid_actor': 'uid_actor',
  'o_actor.text_actor': 'text_actor',
};

/** WL's own "this row is a refund" flag, on both reports. */
const REFUND_FIELD = 'o_action.is_refund_transaction';
/**
 * The item TITLE, and it is load-bearing rather than decorative: twelve repeat
 * groups in the item report differ in nothing else - the same item key, date and
 * amount titled "General credit" on one row and "Account Payment" on the other.
 * Without it those twelve pairs collapse into one row each.
 *
 * It arrives nested: `a_item` is an array of item descriptors, each with a
 * `text_title`. The first is taken - every observed row has exactly one.
 */
const ITEM_TITLE_FIELD = 'o_purchase_item_title_link.a_item';

/** Integer columns. Everything else mapped above is text, money or a timestamp. */
const INTEGER_COLUMNS = new Set([
  'id_table',
  'id_purchase_item',
  'id_pay_transaction_status',
  'id_currency',
  'i_quantity',
]);

/** Columns that are WL keys, so a numeric-looking value stays a string. */
const KEY_COLUMNS = new Set([
  'k_pay_transaction',
  'k_purchase',
  'k_purchase_item',
  'k_id',
  'k_promotion',
  'k_location',
  'uid_client',
  'uid_actor',
]);

function fieldMap(report: TransactionReport): Readonly<Record<string, string>> {
  return report === 'item' ? ITEM_FIELDS : PAYMENT_FIELDS;
}

export function transactionTable(report: TransactionReport): string {
  return report === 'item' ? 'pay_transaction_item' : 'pay_transaction';
}

/**
 * Refuses a page whose field list has stopped carrying something this sync maps.
 *
 * The same guard, for the same reason, as assertReportFields in clients.ts: a
 * mapper that looks values up by name skips an id it does not recognise, which
 * is right for the hundred report columns we ignore and silent for the ones we
 * need. A renamed or removed column would simply stop being written while the
 * pass reported `ok`.
 *
 * Measured before it was added, so it is a no-op today rather than a new
 * blocker: all mapped ids are present on cid 739 (141 fields) and cid 799 (140
 * fields) as returned live on 17 Sep 2026.
 */
export function assertTransactionFields(
  report: TransactionReport,
  fields: readonly string[],
): void {
  const present = new Set(fields);
  const required = [
    ...Object.keys(fieldMap(report)),
    REFUND_FIELD,
    ...(report === 'item' ? [ITEM_TITLE_FIELD] : []),
  ];
  const missing = required.filter((id) => !present.has(id));
  if (missing.length === 0) return;
  throw new Error(
    `WL transaction report (${report} view) is missing ${String(missing.length)} field ` +
      `id(s) this sync maps: ${missing.join(', ')}. Report columns are configured in ` +
      `the WL portal, so a removed or renamed column stops that column being ` +
      `written without any other error. Refusing the page.`,
  );
}

export interface TransactionRow {
  readonly row_hash: string;
  readonly i_occurrence: number;
  readonly [column: string]: unknown;
}

/**
 * The identity of a report row: sha256 over the mapped values, in field-map
 * order, plus the refund flag and (for the item report) the title.
 *
 * WHY A HASH AT ALL. WL publishes no unique row key for either report -
 * `k_pay_transaction` is null on 10,838 of 10,913 item rows, and every
 * combination of the keys it does publish collapses a sale row together with its
 * later refund row. 0038's header has the full measurement table.
 *
 * WHY OVER THE MAPPED VALUES AND NOT THE WHOLE ROW. The full row carries signed
 * `url` tokens and tooltip HTML that are free to change between builds; hashing
 * them would give the same transaction a new identity and insert a second copy.
 * Hashing exactly what is stored means the hash changes when, and only when, a
 * stored value changes.
 *
 * The separator is a unit separator, so a value containing a pipe or a comma
 * cannot forge a different row's hash.
 */
export function hashRow(
  patch: Readonly<Record<string, unknown>>,
  order: readonly string[],
): string {
  const parts = order.map((column) => JSON.stringify(patch[column] ?? null));
  return createHash('sha256').update(parts.join('')).digest('hex');
}

/** The column order a hash is taken over. Fixed, or every re-read is a new row. */
function hashOrder(report: TransactionReport): readonly string[] {
  return [
    ...Object.values(fieldMap(report)),
    'is_refund',
    ...(report === 'item' ? ['item_title'] : []),
  ];
}

/**
 * Maps one page of report rows into table rows, numbering repeats.
 *
 * `seen` IS THE CALLER'S, ON PURPOSE. Repeat numbering has to span pages: half
 * the repeat groups are non-adjacent in report order, so a per-page counter
 * would number the second copy 0 again and the write would silently merge it
 * into the first. The caller owns one map per window read and passes it to every
 * page.
 */
export function mapTransactionRows(
  report: TransactionReport,
  fields: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
  seen: Map<string, number> = new Map(),
): readonly TransactionRow[] {
  const map = fieldMap(report);
  const order = hashOrder(report);
  const refundIdx = fields.indexOf(REFUND_FIELD);
  const titleIdx = fields.indexOf(ITEM_TITLE_FIELD);
  const out: TransactionRow[] = [];

  for (const row of rows) {
    const patch: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i += 1) {
      const column = map[fields[i] ?? ''];
      if (column === undefined) continue;
      patch[column] = readValue(column, row[i]);
    }
    // WL sends a real boolean here on every observed row, so false is an answer
    // rather than an absence - which is why the column is not null default false.
    patch.is_refund = refundIdx === -1 ? false : row[refundIdx] === true;
    if (report === 'item') patch.item_title = readItemTitle(row[titleIdx]);

    // The payment report's transaction key is not null on any of 10,196 rows and
    // the column is NOT NULL, so a row without one is dropped rather than
    // allowed to fail the whole page. Nothing observed reaches this.
    if (report === 'payment' && typeof patch.k_pay_transaction !== 'string') continue;

    const row_hash = hashRow(patch, order);
    const i_occurrence = seen.get(row_hash) ?? 0;
    seen.set(row_hash, i_occurrence + 1);
    out.push({ ...patch, row_hash, i_occurrence });
  }
  return out;
}

export interface WriteTransactionPageInput {
  readonly kBusiness: string;
  readonly runId: string;
  readonly report: TransactionReport;
  readonly page: ReportPage;
  readonly fields: readonly string[];
  readonly syncedAt: string;
  /** Repeat counter shared across every page of one window read. */
  readonly seen: Map<string, number>;
}

/**
 * Stores one page: the payload verbatim, the stubs the FKs need, then the rows.
 *
 * STUBS FIRST, so a payer or a location we have never enumerated does not fail
 * the pass - the same stub-don't-fail pattern purchases.ts uses. A person stub
 * is (uid, k_business) only, so a later profile or client-list sync fills the
 * name and email without this overwriting anything.
 *
 * `field_group` is 'transaction': a reader tracing a `pay_transaction` row back
 * lands on the report page it was parsed from, not on a receipt that happens to
 * mention the same purchase.
 */
export async function writeTransactionPage(
  db: SupabaseClient,
  input: WriteTransactionPageInput,
): Promise<{ rawWlId: string; rows: readonly TransactionRow[] }> {
  const rawWlId = await storeRawWl(db, {
    kBusiness: input.kBusiness,
    sourceEndpoint: WL_PATHS.reportQuery,
    targetKind: 'page',
    runId: input.runId,
    response: input.page.response,
  });

  // AFTER the raw store, deliberately: if the report's shape has changed, the
  // payload that proves it is already in raw_wl and needs no second WL call.
  assertTransactionFields(input.report, input.fields);

  const rows = mapTransactionRows(input.report, input.fields, input.page.rows, input.seen);
  if (rows.length === 0) return { rawWlId, rows };

  const uids = [
    ...new Set(rows.map((r) => r.uid_client).filter((v): v is string => typeof v === 'string')),
  ];
  if (uids.length > 0) {
    await db.upsert(
      'person',
      uids.map((uid) => ({ uid, k_business: input.kBusiness })),
      { onConflict: 'uid' },
    );
  }
  const locations = [
    ...new Set(rows.map((r) => r.k_location).filter((v): v is string => typeof v === 'string')),
  ];
  if (locations.length > 0) {
    await db.upsert(
      'location',
      locations.map((k_location) => ({ k_location, k_business: input.kBusiness })),
      { onConflict: 'k_location' },
    );
  }

  const table = transactionTable(input.report);
  await db.upsert(
    table,
    rows.map((r) => ({ ...r, k_business: input.kBusiness, synced_at: input.syncedAt })),
    { onConflict: 'k_business,row_hash,i_occurrence' },
  );
  await linkRows(
    db,
    rawWlId,
    table,
    rows.map((r) => `${r.row_hash}|${String(r.i_occurrence)}`),
    'transaction',
  );

  return { rawWlId, rows };
}

/**
 * WL's absent value is `null` or `""`; both become null.
 *
 * A key is kept as the string it arrives as - `"0097"` loses its leading zero as
 * a number, which is the house rule. An `id_*` / `i_*` column is coerced to the
 * integer it already is. Money is left as WL's string for Postgres to cast into
 * numeric(12,2): parsing it here would put it through a float first, which is
 * precisely what the money rule forbids.
 */
function readValue(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  if (KEY_COLUMNS.has(column)) {
    // "0" is WL's placeholder for "no location"; storing it would stub a location
    // row that does not exist and point transactions at it (purchases.ts hit
    // this first).
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text === '0' ? null : text;
  }
  if (INTEGER_COLUMNS.has(column)) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }
    return null;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // WL pads sort keys with a NUL byte ("alison steele\u0000"). Postgres rejects
    // a NUL inside text outright, so it is stripped wherever it appears.
    return value.replace(/\0/g, '').trim();
  }
  return null;
}

/** `o_purchase_item_title_link.a_item[0].text_title`, defensively. */
function readItemTitle(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  if (typeof first !== 'object' || first === null) return null;
  const title = (first as Record<string, unknown>).text_title;
  if (typeof title !== 'string') return null;
  const trimmed = title.replace(/\0/g, '').trim();
  return trimmed.length === 0 ? null : trimmed;
}
