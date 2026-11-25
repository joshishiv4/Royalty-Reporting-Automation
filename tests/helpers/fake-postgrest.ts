import type { SupabaseClient } from '../../src/supabase/client.js';

/**
 * An in-memory stand-in for the PostgREST client, for the lesson sign-off tests.
 *
 * Understands only the filters those modules send: `col=eq.v`, `col=in.(a,b)`,
 * `col=is.null`, `col=not.is.null`, `col=lt.v` and `col=gte.v` (numbers compare
 * as numbers, everything else as strings). `select`, `order` and `limit` are
 * ignored - rows come back in insertion order. Writes are recorded so a test can
 * assert exactly what was written, and `update` returns the rows it changed, as
 * PostgREST does with return=representation.
 */
export type Row = Record<string, unknown>;

const IGNORED = new Set(['select', 'order', 'limit', 'offset']);

function matches(row: Row, query: string): boolean {
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const col = part.slice(0, eq);
    if (IGNORED.has(col)) continue;
    const cond = decodeURIComponent(part.slice(eq + 1));
    const value = row[col];
    if (cond === 'is.null') {
      if (value !== null && value !== undefined) return false;
    } else if (cond === 'not.is.null') {
      if (value === null || value === undefined) return false;
    } else if (cond.startsWith('eq.')) {
      if (String(value) !== cond.slice(3)) return false;
    } else if (cond.startsWith('in.(')) {
      const set = cond.slice(4, -1).split(',');
      if (!set.includes(String(value))) return false;
    } else if (cond.startsWith('lt.') || cond.startsWith('gte.')) {
      const lt = cond.startsWith('lt.');
      const bound = cond.slice(lt ? 3 : 4);
      const a = typeof value === 'number' ? value : String(value);
      const b = typeof value === 'number' ? Number(bound) : bound;
      if (lt ? !(a < b) : !(a >= b)) return false;
    } else {
      throw new Error(`fake-postgrest: unsupported filter ${part}`);
    }
  }
  return true;
}

export interface FakeDb {
  readonly db: SupabaseClient;
  readonly tables: Record<string, Row[]>;
  readonly writes: Array<{ op: 'upsert' | 'update'; table: string; rows: Row[]; query?: string }>;
}

export function fakePostgrest(
  initial: Record<string, Row[]>,
  opts: { onUpsert?: (table: string, row: Row) => Row; updateReturnsNothing?: string[] } = {},
): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));
  const writes: FakeDb['writes'] = [];
  const read = (table: string, q: string): Row[] =>
    (tables[table] ?? []).filter((r) => matches(r, q)).map((r) => ({ ...r }));

  const db = {
    select: (t: string, q = '') => Promise.resolve(read(t, q)),
    selectAll: (t: string, q = '') => Promise.resolve(read(t, q)),
    upsert: (t: string, rows: Row[], o: { onConflict: string }) => {
      writes.push({ op: 'upsert', table: t, rows });
      const keys = o.onConflict.split(',');
      const list = (tables[t] ??= []);
      const out: Row[] = [];
      for (const raw of rows) {
        const row = opts.onUpsert ? opts.onUpsert(t, raw) : raw;
        const hit = list.find((r) => keys.every((k) => String(r[k]) === String(row[k])));
        if (hit) Object.assign(hit, raw);
        else list.push({ ...row });
        out.push({ ...(hit ?? row) });
      }
      return Promise.resolve(out);
    },
    update: (t: string, patch: Row, q: string) => {
      writes.push({ op: 'update', table: t, rows: [patch], query: q });
      if (opts.updateReturnsNothing?.includes(t)) return Promise.resolve([]);
      const hit = (tables[t] ?? []).filter((r) => matches(r, q));
      for (const r of hit) Object.assign(r, patch);
      return Promise.resolve(hit.map((r) => ({ ...r })));
    },
  };
  return { db: db as unknown as SupabaseClient, tables, writes };
}
