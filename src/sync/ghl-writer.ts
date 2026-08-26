import type { ContactSearchFilters, GhlSearchResponse } from '../ghl/client.js';
import type { SupabaseClient } from '../supabase/client.js';

/**
 * Stores a GoHighLevel response verbatim (PRD M06).
 *
 * WHY THIS EXISTS AT ALL. Every WellnessLiving response has been kept since
 * migration 0008 - 2,534 rows on dev - while raw_ghl sat at zero, because
 * nothing ever wrote to it. The matcher read a search, decided a verdict, and
 * threw the evidence away. So "why is this client ambiguous" could only be
 * answered by calling GoHighLevel again and hoping it still says the same thing.
 *
 * WHY THE WHOLE BODY AND NOT THE CONTACTS. The typed view is lossy on purpose:
 * a contact with no id is dropped, and every field beyond the six we name
 * survives only inside `raw`. When the agreed field list finally arrives (the
 * open point on M06), the fields will be parsed out of these stored payloads
 * rather than re-fetched - a re-parse is a query, a re-pull is hours.
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

export async function storeRawGhl(db: SupabaseClient, input: StoreRawGhlInput): Promise<void> {
  await db.insert('raw_ghl', [
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
