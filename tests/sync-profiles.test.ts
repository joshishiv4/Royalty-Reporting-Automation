import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseProfile, writeProfile } from '../src/sync/profiles.js';

const K_BUSINESS = '111111';
const UID = '34714494';

// Captured live 24 Aug 2026 (trimmed): WL sends "" for an absent phone/dob, and
// the body is the record itself, not a keyed object.
function userBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    uid: UID,
    s_mail: 'nyamandrew@gmail.com',
    s_first_name: 'Andrew',
    s_last_name: 'Kondogianis',
    s_phone: '+16314075521',
    s_phone_home: '+16314075521',
    s_phone_work: '',
    dt_birth: '',
    id_gender: 1, // no person column - must be ignored
    k_login_type: '1260510',
    text_login_type: 'Staff Client Profile',
    text_address: '60 Abbot Lane', // no person column - must be ignored
    status: 'ok',
    ...overrides,
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'u.1', kLog: null, httpStatus: 200, latencyMs: 9 };
}

describe('parseProfile', () => {
  it('maps the primary email and contact fields WL actually sent', () => {
    expect(parseProfile(userBody(), UID, K_BUSINESS)).toEqual({
      uid: UID,
      k_business: K_BUSINESS,
      email: 'nyamandrew@gmail.com',
      first_name: 'Andrew',
      last_name: 'Kondogianis',
      phone: '+16314075521',
      phone_home: '+16314075521',
      k_login_type: '1260510',
      text_login_type: 'Staff Client Profile',
    });
  });

  it('OMITS empty fields so an upsert cannot blank an existing value', () => {
    const row = parseProfile(userBody(), UID, K_BUSINESS);
    // "" phone_work and "" dt_birth are absent from the patch, not present-as-null.
    expect('phone_work' in row).toBe(false);
    expect('date_of_birth' in row).toBe(false);
  });

  it('stores date_of_birth only when WL sent a real date', () => {
    const row = parseProfile(userBody({ dt_birth: '1989-11-14' }), UID, K_BUSINESS);
    expect(row.date_of_birth).toBe('1989-11-14');
  });

  it('never invents columns person does not have (gender, address)', () => {
    const row = parseProfile(userBody(), UID, K_BUSINESS) as Record<string, unknown>;
    expect('id_gender' in row).toBe(false);
    expect('text_address' in row).toBe(false);
  });

  it('keeps only the anchor when the body is bare', () => {
    expect(parseProfile({}, UID, K_BUSINESS)).toEqual({ uid: UID, k_business: K_BUSINESS });
  });
});

describe('writeProfile', () => {
  function fakeDb() {
    const calls: Array<{ op: string; table: string; rows?: unknown[]; group?: unknown }> = [];
    const db = {
      // enqueue writes through a Postgres function now (migration 0032), so a
      // fake db has to answer it. It reports everything as inserted: these
      // tests are about what gets queued, not how Postgres resolves a clash.
      rpc: vi.fn((_fn: string, args: { items: unknown[] }) => Promise.resolve(args.items.length)),
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-u' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'upsert', table, rows });
        return Promise.resolve(rows);
      }),
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  const input = (body: unknown) => ({
    kBusiness: K_BUSINESS,
    uid: UID,
    response: response(body),
    runId: 'run',
  });

  it('stores the raw payload, upserts the person patch, and links it', async () => {
    const { db, calls } = fakeDb();
    const result = await writeProfile(db, input(userBody()));

    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual([
      'insert:raw_wl',
      'upsert:person',
      'insert:raw_link',
    ]);
    // Upsert on uid: a re-run updates the same row, never duplicates.
    const patch = calls.find((c) => c.op === 'upsert')!.rows![0] as Record<string, unknown>;
    expect(patch.uid).toBe(UID);
    expect(patch.email).toBe('nyamandrew@gmail.com');
    // email, first_name, last_name, phone, phone_home, k_login_type, text_login_type
    // (phone_work and dt_birth were "" -> omitted).
    expect(result).toMatchObject({ hasEmail: true, fieldsFilled: 7 });
  });

  it('reports hasEmail false and stores the payload when no email was sent', async () => {
    const { db } = fakeDb();
    const result = await writeProfile(db, input(userBody({ s_mail: '' })));
    expect(result.hasEmail).toBe(false);
  });
});
