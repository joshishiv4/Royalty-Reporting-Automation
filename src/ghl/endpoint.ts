import type { GhlConfig } from '../config/schema.js';

/**
 * Builds a GoHighLevel URL from configuration.
 *
 * Nothing here talks to GHL - it is the single place that assembles a GHL URL,
 * so that no host is ever written at a call site. `no-hardcoded-config.test.ts`
 * enforces this by scanning for `leadconnectorhq.` anywhere under src/ or api/.
 */
export function buildGhlUrl(ghl: GhlConfig, path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`GHL path must start with "/": received "${path}"`);
  }
  return new URL(`${ghl.baseUrl}${path}`).toString();
}

/**
 * GHL endpoint paths. Paths are stable across environments; hosts are not.
 *
 * Only what the matcher actually needs. This client is read-only by
 * construction: adding a create or update path here is a design change, not a
 * one-line addition, and the shape of GhlClient makes those verbs unreachable
 * anyway (see client.ts).
 */
export const GHL_PATHS = {
  /** POST search body. Used by the person → contact matcher (PRD M08). */
  contactsSearch: '/contacts/search',
} as const;

export type GhlPathName = keyof typeof GHL_PATHS;
