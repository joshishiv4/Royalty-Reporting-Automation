import type { ContactSearchFilters, GhlSearchResponse } from '../ghl/client.js';
import type { GhlContactSnapshot } from '../ghl/snapshot.js';
import type { SupabaseClient } from '../supabase/client.js';

/**
 * Stores what GoHighLevel said - verbatim in `raw_ghl`, and typed in
 * `ghl_contact` (PRD M06).
 *
 * WHY THIS EXISTS AT ALL. Every WellnessLiving response has been kept since
 * migration 0008 - 2,534 rows on dev - while raw_ghl sat at zero, because
 * nothing ever wrote to it. The matcher read a search, decided a verdict, and
 * threw the evidence away. So "why is this client ambiguous" could only be
 * answered by calling GoHighLevel again and hoping it still says the same thing.
 *
 * WHY THE WHOLE BODY AND NOT THE CONTACTS. The typed view is lossy on purpose:
 * a contact with no id is dropped, and every field beyond the six we name
 * survives only inside `raw`. That is what made the enrichment cheap when it
 * finally landed: migration 0026 backfilled 317 clients out of these stored
 * payloads with no call to GoHighLevel at all. A re-parse is a query, a re-pull
 * is hours - and keeping the body is what preserved the choice.
 *
 * WHY A FAILURE TO STORE IS NOT A FAILURE TO MATCH. GoHighLevel is
 * supplementary; the verdict is already decided by the time this runs. Losing
 * the audit copy is worth a health issue, not a failed sync run - the same
 * reasoning that makes a GHL outage requeue rather than throw.
 */

type SearchFn = (filters: ContactSearchFilters) => Promise<GhlSearchResponse>;

export interface StoreRawGhlInput {
  readonly locationId: string;
  readonly sourceEndpoint: string;
  readonly response: GhlSearchResponse;
  readonly runId: string;
  /** The WellnessLiving client this search was run for. */
  readonly personUid: string;
}

/**
 * Returns the id of the stored row, so `ghl_contact.raw_ghl_id` can point at the
 * exact payload a snapshot was parsed out of. Null if PostgREST returned no
 * representation - the row is stored either way, and a missing provenance link
 * must not fail the enrichment write that follows.
 */
export async function storeRawGhl(
  db: SupabaseClient,
  input: StoreRawGhlInput,
): Promise<string | null> {
  const stored = await db.insert<{ id: string }>('raw_ghl', [
    {
      location_id: input.locationId,
      source_endpoint: input.sourceEndpoint,
      // A search is neither a single record nor a cursor-driven page: it is a
      // query that may legitimately match nobody. 'page' is the honest one of
      // the three - a slice of the location - and target_key stays null because
      // there is no cursor and there may be no contact.
      target_kind: 'page',
      person_uid: input.personUid,
      request_params: input.response.requestParams,
      payload: input.response.body,
      http_status: input.response.httpStatus,
      ghl_trace_id: input.response.ghlTraceId,
      run_id: input.runId,
      latency_ms: input.response.latencyMs,
    },
  ]);
  return stored[0]?.id ?? null;
}

export interface UpsertGhlContactInput {
  readonly snapshot: GhlContactSnapshot;
  /** When GoHighLevel was asked - the fetch timestamp M06 asks for. */
  readonly fetchedAt: string;
  /** Which stored payload this was parsed out of, when known. */
  readonly rawGhlId: string | null;
  /**
   * The configured location, used only when the contact did not name its own.
   * `ghl_contact.location_id` is `not null`, and an empty string would satisfy
   * that while meaning nothing.
   */
  readonly locationId: string;
}

/**
 * Stores the fields and tags of one GoHighLevel contact (PRD M06, second half).
 *
 * ONE ROW PER CONTACT, NOT PER PERSON - which is the whole reason `ghl_contact`
 * is a table rather than columns on `person`. A family sharing a phone number
 * resolves several clients to one contact (307 distinct contacts across 317
 * matched clients, measured 26 Aug 2026), so this upsert is expected to be
 * reached more than once for the same id, and must be idempotent rather than
 * merely tolerated.
 *
 * NO EXTRA API CALL. The snapshot is projected from the search response the
 * matcher already made. Enrichment is fetched exactly once, at match time, and
 * never refreshed - see migration 0026 for what that costs.
 *
 * TAGS REPLACE, THEY DO NOT MERGE. The upsert overwrites `tags` wholesale
 * because that is what GoHighLevel just stated. Merging would leave a tag on the
 * record after GoHighLevel had retired it, with nothing able to take it off
 * again; every fetch is kept in `raw_ghl`, so replacing loses no history.
 */
export async function upsertGhlContact(
  db: SupabaseClient,
  input: UpsertGhlContactInput,
): Promise<void> {
  const { snapshot } = input;

  await db.upsert(
    'ghl_contact',
    [
      {
        ghl_contact_id: snapshot.ghlContactId,
        location_id: snapshot.locationId.length > 0 ? snapshot.locationId : input.locationId,
        fields: snapshot.fields,
        tags: snapshot.tags,
        fetched_at: input.fetchedAt,
        raw_ghl_id: input.rawGhlId,
      },
    ],
    { onConflict: 'ghl_contact_id' },
  );

  await registerCustomFields(db, Object.keys(snapshot.fields));
}

/**
 * Adds any custom field id not already in the catalogue.
 *
 * WHY REGISTER AT ALL. `ghl_custom_field` is what turns "which fields do we
 * report" from a migration into an UPDATE, and it can only serve that purpose if
 * it lists what the location actually uses. Asking somebody to maintain that list
 * by hand guarantees it drifts - so the sync registers what it sees. The row
 * lands with a null name and `is_reported` false: seen is not agreed.
 *
 * WHY READ BEFORE WRITING. An unconditional upsert would rewrite the same three
 * rows on nearly every matched client, moving `updated_at` on a row that did not
 * change - and 0006 defines `updated_at` as when the row last CHANGED. The read
 * is three rows on this location and is skipped entirely for the 78% of contacts
 * that carry no custom field at all.
 *
 * The write is still an upsert, not an insert: two workers can decide the same
 * new id is unknown at the same time, and a duplicate key there would fail a
 * match for a catalogue entry.
 */
async function registerCustomFields(db: SupabaseClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  const known = await db.selectAll<{ ghl_field_id: string }>(
    'ghl_custom_field',
    'order=ghl_field_id.asc&select=ghl_field_id',
  );
  const seen = new Set(known.map((row) => row.ghl_field_id));
  const unknown = ids.filter((id) => !seen.has(id));
  if (unknown.length === 0) return;

  await db.upsert(
    'ghl_custom_field',
    unknown.map((id) => ({ ghl_field_id: id })),
    { onConflict: 'ghl_field_id' },
  );
}

/**
 * Wraps a GoHighLevel client so every search it answers is stored.
 *
 * The recorder sits at the client boundary rather than inside the matcher for
 * the same reason WlClient.request() owns the status assertion: one place that
 * cannot be bypassed. The matcher makes one call or two depending on whether
 * phone found anything, and neither it nor any future caller has to remember to
 * store the result.
 *
 * A rejected search records nothing, which is correct - there is no response to
 * keep, and the error is the queue's business.
 */
export function recordingGhl(
  ghl: { searchContacts: SearchFn },
  sink: (response: GhlSearchResponse) => void,
): { searchContacts: SearchFn } {
  return {
    searchContacts: async (filters) => {
      const response = await ghl.searchContacts(filters);
      sink(response);
      return response;
    },
  };
}
