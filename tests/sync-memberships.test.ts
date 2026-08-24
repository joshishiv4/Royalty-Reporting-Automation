import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseMembership, writeMembership } from '../src/sync/memberships.js';

const K_BUSINESS = '111111';
const K_ITEM = '145680548';
const K_PURCHASE = '141141329';
const RAW_ID = 'raw-e';

/**
 * Shaped on the live element payload (probed 24 Aug 2026). The defaults are the
 * QUIET case dev is full of - an appointment with nothing set - because that is
 * what the omit rules have to survive: WL fills these with "" and 0, not null.
 */
function elementBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    sid_value: 'appointment',
    i_payment_period: 0,
    m_period_price: '',
    is_hold: false,
    dt_hold_start: '',
    dt_hold_end: '',
    is_cancel_pending: false,
    dt_cancel: '',
    dl_cancel: '',
    is_renew: false,
    i_renew: 0,
    m_refund: '0',
    status: 'ok',
    ...overrides,
  };
}

/** A live-shaped membership: the "service-membership" case, 11 of 109 on dev. */
function membershipBody(overrides: Record<string, unknown> = {}): unknown {
  return elementBody({
    sid_value: 'service-membership',
    i_payment_period: 1,
    m_period_price: '230.00',
    is_renew: true,
    i_renew: 3,
    ...overrides,
  });
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'e.1', kLog: null, httpStatus: 200, latencyMs: 9 };
}

function parse(body: unknown): Record<string, unknown> {
  return parseMembership(body, K_ITEM, K_PURCHASE, K_BUSINESS);
}

describe('parseMembership', () => {
  it('anchors every patch on the item, its purchase and the business', () => {
    expect(parse(elementBody())).toMatchObject({
      k_purchase_item: K_ITEM,
      k_purchase: K_PURCHASE,
      k_business: K_BUSINESS,
    });
  });

  it('maps a membership: payment period, period price and renewal', () => {
    expect(parse(membershipBody())).toMatchObject({
      sid_value: 'service-membership',
      i_payment_period: 1,
      m_period_price: '230.00',
      is_renew: true,
      i_renew: 3,
    });
  });

  it('maps hold state and both hold dates', () => {
    expect(
      parse(
        membershipBody({
          is_hold: true,
          dt_hold_start: '2026-08-01 00:00:00',
          dt_hold_end: '2026-09-01 00:00:00',
        }),
      ),
    ).toMatchObject({
      is_hold: true,
      dt_hold_start: '2026-08-01 00:00:00',
      dt_hold_end: '2026-09-01 00:00:00',
    });
  });

  it('maps pending cancellation and the cancellation date', () => {
    expect(
      parse(membershipBody({ is_cancel_pending: true, dt_cancel: '2025-03-26 22:42:36' })),
    ).toMatchObject({ is_cancel_pending: true, dt_cancel: '2025-03-26 22:42:36' });
  });

  it('keeps a refund NEGATIVE, as WL sends it', () => {
    expect(parse(membershipBody({ m_refund: '-280.00' })).m_refund).toBe('-280.00');
  });

  // The trap this whole writer exists around. WL's no-refund marker is the string
  // "0" - not "0.00", not "" - so a naive truthiness check stores a refund of zero
  // against every unrefunded item in the business.
  it('reads WL\'s "0" no-refund marker as absent, not as a zero refund', () => {
    expect(parse(elementBody()).m_refund).toBeUndefined();
    expect(parse(elementBody({ m_refund: '0.00' })).m_refund).toBeUndefined();
  });

  // MERGE, NEVER CLOBBER. If an empty field were mapped to null instead of
  // omitted, PostgREST would write that null and blank whatever is already there.
  it('OMITS every field WL left empty, so a refresh cannot blank a stored value', () => {
    const row = parse(elementBody());
    for (const col of [
      'm_period_price',
      'i_payment_period',
      'dt_hold_start',
      'dt_hold_end',
      'dt_cancel',
      'i_renew',
      'm_refund',
    ]) {
      expect(row, `${col} must be omitted, not null`).not.toHaveProperty(col);
    }
  });

  // A nullable boolean would force a three-way check on every read. WL always
  // sends a real boolean here, so false is an answer and is stored as one.
  it('ALWAYS writes the three flags, because false is an answer not an absence', () => {
    expect(parse({})).toMatchObject({
      is_hold: false,
      is_cancel_pending: false,
      is_renew: false,
    });
  });

  it('keeps a zero period price, which is not the same as no period price', () => {
    expect(parse(membershipBody({ m_period_price: '0.00' })).m_period_price).toBe('0.00');
  });

  it('rejects a non-numeric money string rather than handing it to numeric(12,2)', () => {
    expect(parse(membershipBody({ m_period_price: 'n/a' })).m_period_price).toBeUndefined();
  });
});

describe('writeMembership', () => {
  function fakeDb(opts: { itemExists?: boolean } = {}) {
    const calls: Array<{
      op: string;
      table: string;
      rows?: unknown[];
      options?: { onConflict?: string } | undefined;
    }> = [];
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], options?: { onConflict?: string }) => {
        calls.push({ op: 'upsert', table, rows, options });
        return Promise.resolve(rows);
      }),
      update: vi.fn(() => Promise.resolve([])),
      select: vi.fn((table: string) => {
        if (table === 'purchase_item') {
          return Promise.resolve(opts.itemExists === false ? [] : [{ k_purchase: K_PURCHASE }]);
        }
        return Promise.resolve([]);
      }),
    };
    return { db: db as unknown as SupabaseClient, calls };
  }

  const input = (body: unknown) => ({
    kBusiness: K_BUSINESS,
    kPurchaseItem: K_ITEM,
    response: response(body),
    rawWlId: RAW_ID,
  });

  it('upserts on k_purchase_item, so a re-run refreshes and never duplicates', async () => {
    const { db, calls } = fakeDb();
    await writeMembership(db, input(membershipBody()));

    const upsert = calls.find((c) => c.op === 'upsert' && c.table === 'purchase_item');
    expect(upsert).toBeDefined();
    expect(upsert?.options?.onConflict).toBe('k_purchase_item');
  });

  // The payload was already stored by writeRecipient. Storing it again would
  // double raw_wl for the same evidence.
  it("reuses the recipient write's raw row instead of storing the payload twice", async () => {
    const { db, calls } = fakeDb();
    await writeMembership(db, input(membershipBody()));

    expect(calls.filter((c) => c.table === 'raw_wl')).toHaveLength(0);
    const link = calls.find((c) => c.table === 'raw_link');
    expect(link?.rows).toEqual([
      expect.objectContaining({ raw_wl_id: RAW_ID, field_group: 'membership' }),
    ]);
  });

  // The element body does not echo k_purchase, and purchase_item.k_purchase is
  // NOT NULL - so an unknown item must be skipped, never guessed at.
  it('skips an item that is not in the database rather than inventing its purchase', async () => {
    const { db, calls } = fakeDb({ itemExists: false });
    const result = await writeMembership(db, input(membershipBody()));

    expect(result.written).toBe(false);
    expect(calls.filter((c) => c.op === 'upsert')).toHaveLength(0);
  });

  it('reports a membership as one, and a plain appointment as not', async () => {
    const { db } = fakeDb();
    expect((await writeMembership(db, input(membershipBody()))).isMembership).toBe(true);
    expect((await writeMembership(db, input(elementBody()))).isMembership).toBe(false);
  });

  it('counts only the columns WL actually filled', async () => {
    const { db } = fakeDb();
    // sid_value, i_payment_period, m_period_price, i_renew - four filled.
    expect((await writeMembership(db, input(membershipBody()))).fieldsFilled).toBe(4);
    // The quiet appointment fills sid_value alone.
    expect((await writeMembership(db, input(elementBody()))).fieldsFilled).toBe(1);
  });
});
