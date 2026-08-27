import type { GhlContact } from './client.js';

/**
 * Turns a GoHighLevel contact into the row `ghl_contact` stores (PRD M06).
 *
 * WHY THIS IS A SEPARATE, PURE FUNCTION. It is the only place that decides what
 * a stored field or tag means, and it must give the same answer twice: once from
 * a live search response, and once from a payload re-parsed out of `raw_ghl`
 * months later. A projection buried in the sync pass could only be tested
 * through a fake database; here it is testable on a literal.
 *
 * WHAT IS NOT DECIDED HERE. Which fields may be REPORTED is not this function's
 * business - it keeps every field the contact carried, and
 * `ghl_custom_field.is_reported` filters at read time. That split is what makes
 * confirming the agreed field list an UPDATE rather than a migration, and it is
 * why this function has no configuration argument to get wrong.
 *
 * MEASURED SHAPES, 26 Aug 2026, over all 1,098 stored searches:
 *   - `customFields` was present on 325 of 325 contacts and always an array,
 *     always of `{id, value}` with `value` a string. 254 of them were EMPTY -
 *     an empty bag is the normal case, not a fault.
 *   - `tags` was present on 325 of 325 and always an array of lowercase strings;
 *     44 distinct values, 1-11 per contact, 2 typical.
 * Both are still guarded. The measurement says what GoHighLevel does today, not
 * what it will do after a release, and a re-parse that throws on a shape change
 * would take the sync down for data that is supplementary by design.
 */

export interface GhlContactSnapshot {
  readonly ghlContactId: string;
  readonly locationId: string;
  /** GHL custom field id -> value, every field the contact carried. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
}

/**
 * Projects one contact.
 *
 * Returns null when the contact carries no id, which is the same judgement the
 * matcher makes: a contact with no id cannot be linked to, so there is nothing
 * to key a row by. Storing it under an empty string would create one row that
 * every id-less contact overwrote in turn.
 */
export function contactSnapshot(contact: GhlContact): GhlContactSnapshot | null {
  if (contact.id.length === 0) return null;

  return {
    ghlContactId: contact.id,
    locationId: contact.locationId,
    fields: readFields(contact.raw['customFields']),
    tags: readTags(contact.raw['tags']),
  };
}

/**
 * Reads `customFields` into a plain id -> value object.
 *
 * KEYED BY ID, NOT BY NAME, and that is not laziness. GoHighLevel does not send
 * a name in the contact response - only the id - and the endpoint that maps one
 * to the other (`GET /locations/{id}/customFields`) answers 401 for this token,
 * which has contacts scope only. A name here would have to be invented.
 *
 * The value is kept as it arrived rather than coerced to a string: a
 * single-select field sends a string but a multi-select sends an array, and
 * flattening the second into the first would lose the difference silently.
 *
 * A duplicate id keeps the LAST occurrence, which is what a plain object does
 * anyway. Not observed, and not worth a branch that nothing can exercise.
 */
function readFields(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};

  const fields: Record<string, unknown> = {};
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    fields[id] = record['value'] ?? null;
  }
  return fields;
}

/**
 * Reads `tags` into a string array.
 *
 * Non-strings are dropped rather than stringified. `ghl_contact.tags` is
 * `text[]` and a tag is a label a human typed into GoHighLevel; a number or an
 * object arriving here would mean the field is not what we think it is, and
 * `String(...)` would hide that behind a plausible-looking value.
 *
 * Order is left exactly as GoHighLevel sent it. It carries no meaning that we
 * know of, so sorting would be inventing one - and it would make two identical
 * tag sets compare unequal against the raw payload they came from.
 */
function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === 'string');
}
