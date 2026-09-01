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
    // Session counts. i_left is 0 on every live item - it is NOT the remainder.
    i_limit: 0,
    i_left: 0,
    i_remain: 0,
    i_use: 0,
    i_book: 0,
    i_buy: 1,
    status: 'ok',
    ...overrides,
  };
}

/** The live four-session package: limit 4, used 3, ONE remaining, i_left 0. */
function packageBody(overrides: Record<string, unknown> = {}): unknown {
  return elementBody({
    sid_value: 'service-limit',
    s_title: 'Quick Play Package (4 Lessons)',
    i_limit: 4,
    i_left: 0,
    i_remain: 1,
    i_use: 3,
    ...overrides,
  });
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

describe('parseMembership session counts (PRD 6.4)', () => {
  it('stores package size, used and remaining as WL sends them', () => {
    expect(parse(packageBody())).toMatchObject({
      i_limit: 4,
      i_use: 3,
      i_remain: 1,
    });
  });

  // Q14. The fields never contradicted each other - i_left is simply not the
  // remaining count. It is 0 on 109 of 109 live items, including this one, where
  // one session genuinely remains.
  it('keeps i_left at zero WITHOUT treating it as the remainder', () => {
    const row = parse(packageBody());
    expect(row.i_left).toBe(0);
    expect(row.i_remain).toBe(1);
  });

  // The whole point of storing counts. readInt drops zeros for membership terms;
  // doing that here would erase the difference between a spent package and one
  // that was never limited.
  it('KEEPS a zero remaining, because a spent package is not an absent one', () => {
    const spent = parse(packageBody({ i_use: 4, i_remain: 0 }));
    expect(spent.i_remain).toBe(0);
    expect(spent.i_limit).toBe(4);
  });

  it('does not compute i_remain, so a WL disagreement stays visible', () => {
    // limit 8, used 2 would "obviously" be 6 - but WL said 5, and we store 5.
    expect(parse(packageBody({ i_limit: 8, i_use: 2, i_remain: 5 })).i_remain).toBe(5);
  });

  it('reads a count sent as a numeric string', () => {
    expect(parse(packageBody({ i_remain: '7' })).i_remain).toBe(7);
  });

  it('omits a count WL did not send at all', () => {
    const row = parse(packageBody({ i_limit: undefined }));
    expect(row).not.toHaveProperty('i_limit');
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
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], options?: { onConflict?: string }) => {
        calls.push({ op: 'upsert', table, rows, options });
        return Promise.resolve(rows);
      }),
      update: vi.fn((table: string) =>
        Promise.resolve(table === 'sync_job_state' ? [{ job_name: 'j' }] : []),
      ),
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
    // sid_value, i_payment_period, m_period_price, i_renew, plus the six
    // session counts - ten filled.
    expect((await writeMembership(db, input(membershipBody()))).fieldsFilled).toBe(10);
    // The quiet appointment fills sid_value and its six counts.
    expect((await writeMembership(db, input(elementBody()))).fieldsFilled).toBe(7);
  });
});
