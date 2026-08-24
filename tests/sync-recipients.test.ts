import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parsePurchaseElement, writeRecipient } from '../src/sync/recipients.js';

const K_BUSINESS = '111111';
const K_ITEM = '145680548';
const K_PURCHASE = '141141329';

// Captured live 24 Aug 2026 (trimmed): uid_payer can be NULL where uid_recipient
// never was, and s_payer arrives as "" alongside it.
function elementBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    uid_recipient: '43827958',
    s_recipient: 'Marc Joseph',
    uid_payer: null,
    s_payer: '',
    status: 'ok',
    ...overrides,
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'e.1', kLog: null, httpStatus: 200, latencyMs: 9 };
}

describe('parsePurchaseElement', () => {
  it('maps recipient and payer, reading empty strings and nulls as null', () => {
    expect(parsePurchaseElement(elementBody())).toEqual({
      uidRecipient: '43827958',
      sRecipient: 'Marc Joseph',
      uidPayer: null,
      sPayer: null,
    });
  });

  it('reads the "0" nobody-placeholder as null, like k_location "0"', () => {
    const parsed = parsePurchaseElement(elementBody({ uid_recipient: '0' }));
    expect(parsed.uidRecipient).toBeNull();
  });

  it('coerces a numeric uid to text (WL keys switch types across endpoints)', () => {
    const parsed = parsePurchaseElement(elementBody({ uid_recipient: 43827958 }));
    expect(parsed.uidRecipient).toBe('43827958');
  });

  it('returns all nulls for a bare body', () => {
    expect(parsePurchaseElement({})).toEqual({
      uidRecipient: null,
      sRecipient: null,
      uidPayer: null,
      sPayer: null,
    });
  });
});

describe('writeRecipient', () => {
  /**
   * A fake db whose select answers per table: the item row (for k_purchase), the
   * purchase row (current uid_recipient), and any open conflicts.
   */
  function fakeDb(opts: { existingRecipient?: string | null; openConflicts?: number } = {}) {
    const calls: Array<{ op: string; table: string; query?: string; rows?: unknown[] }> = [];
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-e' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'upsert', table, rows });
        return Promise.resolve(rows);
      }),
      update: vi.fn((table: string, _p: unknown, query: string) => {
        calls.push({ op: 'update', table, query });
        return Promise.resolve([]);
      }),
      select: vi.fn((table: string, query: string) => {
        calls.push({ op: 'select', table, query });
        if (table === 'purchase_item') return Promise.resolve([{ k_purchase: K_PURCHASE }]);
        if (table === 'purchase')
          return Promise.resolve([{ uid_recipient: opts.existingRecipient ?? null }]);
        if (table === 'sync_conflict')
          return Promise.resolve(
            Array.from({ length: opts.openConflicts ?? 0 }, () => ({ id: 'c' })),
          );
        return Promise.resolve([]);
      }),
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  const input = (body: unknown) => ({
    kBusiness: K_BUSINESS,
    kPurchaseItem: K_ITEM,
    response: response(body),
    runId: 'run',
  });

  it('stubs the person FIRST, then fills a null uid_recipient', async () => {
    const { db, calls } = fakeDb({ existingRecipient: null });
    const result = await writeRecipient(db, input(elementBody()));

    const seq = calls.map((c) => `${c.op}:${c.table}`);
    expect(seq).toEqual([
      'insert:raw_wl',
      'select:purchase_item',
      'select:purchase',
      'upsert:person', // stub before the FK write, or the update rejects
      'update:purchase',
      'insert:raw_link',
    ]);
    // The stub carries ONLY uid + k_business - anything more would clobber an
    // enriched person row.
    expect(calls.find((c) => c.op === 'upsert')!.rows).toEqual([
      { uid: '43827958', k_business: K_BUSINESS },
    ]);
    expect(calls.find((c) => c.op === 'update')!.query).toBe(`k_purchase=eq.${K_PURCHASE}`);
    expect(result).toMatchObject({ recipientSet: true, conflict: false });
  });

  it('is a no-op when the purchase already names the same recipient', async () => {
    const { db, calls } = fakeDb({ existingRecipient: '43827958' });
    const result = await writeRecipient(db, input(elementBody()));
    expect(calls.some((c) => c.op === 'update')).toBe(false);
    expect(calls.some((c) => c.table === 'sync_conflict')).toBe(false);
    expect(result).toMatchObject({ recipientSet: false, conflict: false });
  });

  it('parks a sync_conflict, and never overwrites, when items disagree', async () => {
    const { db, calls } = fakeDb({ existingRecipient: '99999999' });
    const result = await writeRecipient(db, input(elementBody()));

    expect(calls.some((c) => c.op === 'update' && c.table === 'purchase')).toBe(false);
    const conflict = calls.find((c) => c.op === 'insert' && c.table === 'sync_conflict');
    expect(conflict!.rows![0]).toMatchObject({
      table_name: 'purchase',
      record_key: K_PURCHASE,
      reason: 'recipient-differs-by-item',
      detail: {
        existing_uid_recipient: '99999999',
        incoming_uid_recipient: '43827958',
        k_purchase_item: K_ITEM,
      },
    });
    expect(result).toMatchObject({ recipientSet: false, conflict: true });
  });

  it('does not file the same conflict twice while one is open', async () => {
    const { db, calls } = fakeDb({ existingRecipient: '99999999', openConflicts: 1 });
    const result = await writeRecipient(db, input(elementBody()));
    expect(calls.some((c) => c.op === 'insert' && c.table === 'sync_conflict')).toBe(false);
    expect(result).toMatchObject({ conflict: true });
  });

  it('stores the raw payload but writes nothing when the element has no recipient', async () => {
    const { db, calls } = fakeDb();
    const result = await writeRecipient(db, input(elementBody({ uid_recipient: '0' })));
    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual(['insert:raw_wl']);
    expect(result).toMatchObject({ recipientSet: false, conflict: false });
  });
});
