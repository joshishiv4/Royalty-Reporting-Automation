import { SECRET_KEYS, SecretsProviderError, type SecretBundle, type SecretKey } from './types.js';

/**
 * The canonical settings shape, shared by every provider.
 *
 * One shape everywhere means the same JSON that sits in config/settings.dev.json
 * can be uploaded to the secrets manager verbatim - no conversion step, and
 * therefore no chance of a hand-conversion dropping or mistyping a key.
 */
export const SETTINGS_PATHS = {
  'wellnessliving.host': 'WL_API_HOST',
  'wellnessliving.authHost': 'WL_AUTH_HOST',
  'wellnessliving.idRegion': 'WL_ID_REGION',
  'wellnessliving.kBusiness': 'WL_K_BUSINESS',
  'wellnessliving.clientId': 'WL_CLIENT_ID',
  'wellnessliving.clientSecret': 'WL_CLIENT_SECRET',
  'supabase.url': 'SUPABASE_URL',
  'supabase.serviceRoleKey': 'SUPABASE_SERVICE_ROLE_KEY',
  'gohighlevel.host': 'GHL_API_HOST',
  'gohighlevel.version': 'GHL_API_VERSION',
  'gohighlevel.apiToken': 'GHL_API_TOKEN',
  'gohighlevel.locationId': 'GHL_LOCATION_ID',
} as const satisfies Record<string, SecretKey>;

/** Top-level keys that are allowed but carry no setting. */
const METADATA_KEYS = new Set(['$schema', '//', 'note', 'environment']);

const SECTIONS = new Set(['wellnessliving', 'supabase', 'gohighlevel']);

/**
 * Converts a parsed settings object into a flat bundle.
 *
 * Accepts either the nested shape (what a human authors) or flat SECRET_KEYS
 * (what an env-style bundle looks like), so an older flat secret in the secrets
 * manager keeps working.
 *
 * @param providerName used in error messages
 * @param source human-readable origin, e.g. a file path or secret id
 */
export function bundleFromSettings(
  root: Record<string, unknown>,
  providerName: string,
  source: string,
): SecretBundle {
  const looksFlat = SECRET_KEYS.some((key) => key in root);
  const bundle: SecretBundle = {};

  if (looksFlat) {
    for (const key of SECRET_KEYS) {
      const value = coerce(root[key], key, providerName, source);
      if (value !== undefined) bundle[key] = value;
    }
    return bundle;
  }

  rejectUnknownSections(root, providerName, source);

  for (const [dotted, key] of Object.entries(SETTINGS_PATHS)) {
    const value = coerce(readDotted(root, dotted), dotted, providerName, source);
    if (value !== undefined) bundle[key] = value;
  }
  return bundle;
}

/** A typo like "wellnessLiving" must fail loudly, not read as absent. */
function rejectUnknownSections(
  root: Record<string, unknown>,
  providerName: string,
  source: string,
): void {
  const unknown = Object.keys(root).filter((key) => !SECTIONS.has(key) && !METADATA_KEYS.has(key));
  if (unknown.length > 0) {
    throw new SecretsProviderError(
      providerName,
      `unrecognised section(s) in ${source}: ${unknown.join(', ')}. ` +
        `Expected only: ${[...SECTIONS].join(', ')}. Compare against config/settings.example.json.`,
    );
  }
}

function coerce(
  value: unknown,
  label: string,
  providerName: string,
  source: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;

  // Numbers and booleans are accepted because "idRegion": 2 is the natural way
  // to write it. Anything structural is a mistake that must not be stringified
  // into "[object Object]".
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new SecretsProviderError(
      providerName,
      `${label} in ${source} must be a string, number or boolean`,
    );
  }

  const trimmed = String(value).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readDotted(root: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = root;
  for (const part of dotted.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
