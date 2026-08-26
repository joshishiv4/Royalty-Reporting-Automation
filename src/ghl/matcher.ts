import type { GhlContact, GhlClient } from './client.js';

/**
 * Decides which GoHighLevel contact, if any, is a given person (PRD M04).
 *
 * PHONE FIRST, EMAIL SECOND - AND THAT ORDER IS A CORRECTION, NOT A PREFERENCE.
 * The original design searched email first. Live data killed it: client records
 * in WellnessLiving routinely carry the ACADEMY's address or a guardian's rather
 * than the client's own. An email here identifies a household or a business, not
 * a person, so it cannot lead.
 *
 * Phone needs no normalisation. WellnessLiving already stores numbers in full
 * international form (a leading + and country code, observed throughout), the
 * same shape
 * GoHighLevel returns - so the value is passed through exactly as held. Rewriting
 * it would be inventing a difference that is not there.
 *
 * EMAIL IS A FALLBACK, AND A CROWDED ONE IS REJECTED. Two clients sharing an
 * address is precisely the academy/guardian case above. Picking the first, or the
 * newest, or the one with more fields filled would be a guess - and a wrong link
 * puts one person's royalties on another person's record. So more than one match
 * is `ambiguous`: recorded, surfaced in data health, and left for a human.
 *
 * NAMES ARE NEVER USED. Not as a tie-break, not as a confidence boost, not at
 * all. Two students called the same thing is ordinary in a studio, and the cost
 * of being wrong is somebody else's money. There is deliberately no code path
 * here that reads a name, so there is nothing to accidentally start trusting.
 */

export type MatchState = 'matched' | 'ambiguous' | 'unmatched' | 'failed';

export interface MatchSubject {
  readonly uid: string;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface MatchOutcome {
  readonly uid: string;
  readonly state: MatchState;
  /** Set only when state is 'matched'. */
  readonly ghlContactId: string | null;
  /** Which field produced the verdict, for the audit trail. */
  readonly matchedOn: 'phone' | 'email' | null;
  /** How many contacts the deciding search returned. */
  readonly candidates: number;
  /** Why, in words, for data health and for a human reading a row. */
  readonly detail: string;
}

/**
 * Runs the match for one person. Never throws for a data reason - a person who
 * cannot be matched is an outcome, not an error. A transport failure IS thrown,
 * so the queue can retry it rather than recording a false 'unmatched'.
 */
export async function matchPerson(
  ghl: Pick<GhlClient, 'searchContacts'>,
  subject: MatchSubject,
): Promise<MatchOutcome> {
  const base = { uid: subject.uid } as const;

  // ---------------------------------------------------------------- phone
  if (subject.phone !== null && subject.phone.length > 0) {
    const byPhone = await ghl.searchContacts({ phone: subject.phone });
    if (byPhone.contacts.length === 1) {
      return single(base.uid, byPhone.contacts[0], 'phone', 'matched on phone');
    }
    if (byPhone.contacts.length > 1) {
      // Same reasoning as a crowded email: two contacts on one number is a
      // shared handset, and choosing between them would be a guess.
      return {
        ...base,
        state: 'ambiguous',
        ghlContactId: null,
        matchedOn: 'phone',
        candidates: byPhone.contacts.length,
        detail: `phone matched ${String(byPhone.contacts.length)} contacts, so it does not identify anyone`,
      };
    }
    // Nothing on phone: fall through to email. This is the ONLY route to the
    // email search - it never runs alongside, only after.
  }

  // ---------------------------------------------------------------- email
  if (subject.email !== null && subject.email.length > 0) {
    const byEmail = await ghl.searchContacts({ email: subject.email });
    if (byEmail.contacts.length === 1) {
      return single(
        base.uid,
        byEmail.contacts[0],
        'email',
        'matched on email, after phone found nothing',
      );
    }
    if (byEmail.contacts.length > 1) {
      return {
        ...base,
        state: 'ambiguous',
        ghlContactId: null,
        matchedOn: 'email',
        candidates: byEmail.contacts.length,
        detail:
          `email matched ${String(byEmail.contacts.length)} contacts - an academy or ` +
          'guardian address, not a person',
      };
    }
  }

  const searched = [
    subject.phone !== null && subject.phone.length > 0 ? 'phone' : null,
    subject.email !== null && subject.email.length > 0 ? 'email' : null,
  ].filter((x): x is string => x !== null);

  return {
    ...base,
    state: 'unmatched',
    ghlContactId: null,
    matchedOn: null,
    candidates: 0,
    detail:
      searched.length === 0
        ? 'no phone and no email to search on'
        : `no contact found by ${searched.join(' or ')}`,
  };
}

/**
 * Turns the one-candidate case into an outcome.
 *
 * A single candidate is NOT automatically a match: a contact with no id cannot
 * be linked to, and recording 'matched' with a null id would read as success
 * while pointing at nothing. That is 'failed' - something is wrong with the
 * contact, and a human should see it - not 'unmatched', which would say we
 * looked and there was nobody.
 */
function single(
  uid: string,
  contact: GhlContact | undefined,
  matchedOn: 'phone' | 'email',
  detail: string,
): MatchOutcome {
  const id = contact?.id ?? '';
  if (id.length === 0) {
    return {
      uid,
      state: 'failed',
      ghlContactId: null,
      matchedOn,
      candidates: 1,
      detail: `${matchedOn} matched one contact but it carries no id`,
    };
  }
  return { uid, state: 'matched', ghlContactId: id, matchedOn, candidates: 1, detail };
}
