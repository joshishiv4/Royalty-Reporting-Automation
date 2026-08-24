import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parsePromotionList, writePromotionList } from '../src/sync/promotions.js';

const KB = '111111';

// Shape probed live 24 Aug 2026: a_promotion is an ARRAY, id_program a number.
function promotionBody(): unknown {
  return {
    a_promotion: [
      {
        k_promotion: '1486525',
        text_title: 'DJ Group Class | 60 Minutes',
        id_program: 1,
        is_active: '1',
        is_class: '0',
      },
      { text_title: 'No key here' }, // no k_promotion -> skipped
    ],
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'r.1', kLog: null, httpStatus: 200, latencyMs: 3 };
}

describe('parsePromotionList', () => {
  it('maps title, program (number -> text) and active flag, skipping keyless records', () => {
    const rows = parsePromotionList(promotionBody(), KB);
    expect(rows).toEqual([
      {
        k_promotion: '1486525',
        k_business: KB,
        title: 'DJ Group Class | 60 Minutes',
        id_program: '1', // number normalised to text, losslessly
        is_active: true, // "1" -> true
      },
    ]);
  });

  it('also accepts a keyed object, not only an array', () => {
    const keyed = { a_promotion: { '0': { k_promotion: 'p-1', is_active: '0' } } };
    const rows = parsePromotionList(keyed, KB);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ k_promotion: 'p-1', is_active: false });
  });

  it('returns nothing for a body without a_promotion', () => {
    expect(parsePromotionList({}, KB)).toEqual([]);
  });
});

describe('writePromotionList', () => {
  it('stores raw, then upserts promotions on k_promotion and links them', async () => {
    const calls: Array<{ op: string; table: string; onConflict?: string }> = [];
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-p' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[], opts: { onConflict: string }) => {
        calls.push({ op: 'upsert', table, onConflict: opts.onConflict });
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;

    const result = await writePromotionList(db, {
      kBusiness: KB,
      kLocation: '244238',
      response: response(promotionBody()),
      runId: 'run',
    });

    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual([
      'insert:raw_wl',
      'upsert:promotion',
      'insert:raw_link',
    ]);
    expect(calls.find((c) => c.table === 'promotion')!.onConflict).toBe('k_promotion');
    expect(result.count).toBe(1);
  });

  it('writes raw only - no upsert - when the list is empty', async () => {
    const tables: string[] = [];
    const upsert = vi.fn(() => Promise.resolve([]));
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) => {
        tables.push(table);
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-p' }] : rows);
      }),
      upsert,
    } as unknown as SupabaseClient;

    const result = await writePromotionList(db, {
      kBusiness: KB,
      kLocation: '244238',
      response: response({ a_promotion: [] }),
      runId: 'run',
    });

    expect(tables).toEqual(['raw_wl']); // raw always; no promotion upsert, no link
    expect(upsert).not.toHaveBeenCalled();
    expect(result.count).toBe(0);
  });
});
