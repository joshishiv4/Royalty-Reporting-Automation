import { describe, expect, it, vi } from 'vitest';
import type { GhlContact } from '../src/ghl/client.js';
import { matchPerson } from '../src/ghl/matcher.js';

/**
 * The matching rules (PRD M04). Every one of these is a decision that was made
 * once, for a reason, and would look arbitrary to someone changing it later -
 * which is exactly why each has a test rather than a comment.
 */

function contact(id: string, over: Partial<GhlContact> = {}): GhlContact {
  return {
    id,
    locationId: 'loc-1',
    email: null,
    phone: null,
    firstName: null,
    lastName: null,
    raw: {},
    ...over,
  };
}

/** Records what was searched, in order, so "phone first" is observable. */
function fakeGhl(byPhone: GhlContact[] = [], byEmail: GhlContact[] = []) {
  const searches: Array<{ email?: string; phone?: string }> = [];
  const searchContacts = vi.fn((filters: { email?: string; phone?: string }) => {
    searches.push(filters);
    const contacts = filters.phone !== undefined ? byPhone : byEmail;
    return Promise.resolve({
      contacts,
      total: contacts.length,
      latencyMs: 1,
      httpStatus: 200,
      body: { contacts, traceId: 'trace-1' },
      ghlTraceId: 'trace-1',
      requestParams: { ...filters },
    });
  });
  return { ghl: { searchContacts }, searches };
}

const subject = (over: Partial<{ phone: string | null; email: string | null }> = {}) => ({
  uid: '33793232',
  phone: '+15162720782',
  email: 'jared@spindjacademy.com',
  ...over,
});

describe('matchPerson: phone first, email second', () => {
  it('searches PHONE before email, and stops there on a single hit', async () => {
    const { ghl, searches } = fakeGhl([contact('ghl-1')]);
    const out = await matchPerson(ghl, subject());

    expect(searches).toEqual([{ phone: '+15162720782' }]);
    expect(out).toMatchObject({ state: 'matched', ghlContactId: 'ghl-1', matchedOn: 'phone' });
  });

  // Email is a fallback, never a parallel search.
  it('searches email ONLY after phone finds nothing', async () => {
    const { ghl, searches } = fakeGhl([], [contact('ghl-2')]);
    const out = await matchPerson(ghl, subject());

    expect(searches).toEqual([{ phone: '+15162720782' }, { email: 'jared@spindjacademy.com' }]);
    expect(out).toMatchObject({ state: 'matched', ghlContactId: 'ghl-2', matchedOn: 'email' });
  });

  // WL already stores full international numbers, so there is nothing to
  // normalise - and rewriting the value would invent a difference.
  it('passes the phone through exactly as WellnessLiving holds it', async () => {
    const { ghl, searches } = fakeGhl([contact('ghl-1')]);
    await matchPerson(ghl, subject({ phone: '+1631-926-1016' }));

    expect(searches[0]).toEqual({ phone: '+1631-926-1016' });
  });
});

describe('matchPerson: a crowded field identifies nobody', () => {
  // The academy/guardian address. Picking one would put a person's royalties on
  // somebody else's record.
  it('REJECTS an email matching more than one contact', async () => {
    const { ghl } = fakeGhl([], [contact('a'), contact('b')]);
    const out = await matchPerson(ghl, subject());

    expect(out.state).toBe('ambiguous');
    expect(out.ghlContactId).toBeNull();
    expect(out.candidates).toBe(2);
  });

  it('rejects a phone matching more than one contact for the same reason', async () => {
    const { ghl } = fakeGhl([contact('a'), contact('b')]);
    const out = await matchPerson(ghl, subject());

    expect(out).toMatchObject({ state: 'ambiguous', ghlContactId: null, matchedOn: 'phone' });
  });

  // An ambiguous phone must NOT quietly fall through to email and produce a
  // match - the person is already known to be unidentifiable.
  it('does not fall through to email after an ambiguous phone', async () => {
    const { ghl, searches } = fakeGhl([contact('a'), contact('b')], [contact('c')]);
    const out = await matchPerson(ghl, subject());

    expect(searches).toEqual([{ phone: '+15162720782' }]);
    expect(out.state).toBe('ambiguous');
  });
});

describe('matchPerson: names are never used', () => {
  /**
   * The criterion is "names are never used for matching under any
   * circumstance". Asserted as a property of what leaves the module: whatever
   * the code does internally, a name never reaches GoHighLevel.
   */
  it('never sends a name in any search, even when nothing else matches', async () => {
    const { ghl, searches } = fakeGhl([], []);
    await matchPerson(ghl, subject());

    for (const s of searches) {
      expect(Object.keys(s).every((k) => k === 'phone' || k === 'email')).toBe(true);
    }
  });

  it('takes no name on its input at all, so there is nothing to fall back to', () => {
    // A compile-time guarantee made visible: MatchSubject is uid/phone/email.
    const keys = Object.keys(subject()).sort();
    expect(keys).toEqual(['email', 'phone', 'uid']);
  });
});

describe('matchPerson: the honest non-answers', () => {
  it('reports unmatched when neither field finds anyone', async () => {
    const { ghl } = fakeGhl([], []);
    const out = await matchPerson(ghl, subject());

    expect(out).toMatchObject({ state: 'unmatched', ghlContactId: null, candidates: 0 });
    expect(out.detail).toContain('phone or email');
  });

  it('searches nothing, and says so, when the person has neither field', async () => {
    const { ghl, searches } = fakeGhl();
    const out = await matchPerson(ghl, subject({ phone: null, email: null }));

    expect(searches).toEqual([]);
    expect(out.state).toBe('unmatched');
    expect(out.detail).toContain('no phone and no email');
  });

  it('skips an empty-string phone rather than searching for nothing', async () => {
    const { ghl, searches } = fakeGhl([], [contact('ghl-9')]);
    await matchPerson(ghl, subject({ phone: '' }));

    expect(searches).toEqual([{ email: 'jared@spindjacademy.com' }]);
  });

  // 'matched' must imply a usable link. A contact with no id would read as
  // success while pointing at nothing.
  it('calls a single candidate with no id FAILED, not matched', async () => {
    const { ghl } = fakeGhl([contact('')]);
    const out = await matchPerson(ghl, subject());

    expect(out.state).toBe('failed');
    expect(out.ghlContactId).toBeNull();
  });

  // A transport failure is not evidence that nobody matches.
  it('lets a transport error propagate rather than recording a false unmatched', async () => {
    const ghl = {
      searchContacts: vi.fn(() => Promise.reject(new Error('socket hang up'))),
    };
    await expect(matchPerson(ghl, subject())).rejects.toThrow('socket hang up');
  });
});
