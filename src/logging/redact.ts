import type { AppConfig } from '../config/schema.js';

export const REDACTED = '[REDACTED]';

/**
 * Every credential value in the running config.
 *
 * Collected once at startup so log output can be scrubbed even when a secret
 * arrives inside an error message from a third-party SDK.
 */
export function credentialValues(config: AppConfig): string[] {
  return [
    config.wl.clientId,
    config.wl.clientSecret,
    config.supabase.serviceRoleKey,
    config.ghl.apiToken,
  ].filter((v) => v.length > 0);
}

/** Replaces every occurrence of a known credential in `text` with [REDACTED]. */
export function redact(text: string, values: readonly string[]): string {
  let output = text;
  // Longest first, so a credential that contains another one is fully removed.
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length < 8) continue;
    output = output.split(value).join(REDACTED);
  }
  return output;
}

/**
 * A safe fingerprint of a secret: enough to tell two values apart in a log or
 * to confirm a rotation took effect, not enough to use.
 */
export function fingerprint(value: string): string {
  if (value.length === 0) return '(empty)';
  if (value.length < 12) return `${REDACTED} (len ${String(value.length)})`;
  return `${value.slice(0, 3)}...${value.slice(-2)} (len ${String(value.length)})`;
}

/**
 * A description of the resolved config that is safe to print.
 *
 * Credentials become fingerprints. Host, region and business id are shown as
 * "set"/"missing" only - they identify the client's business and, per the
 * architecture doc, must not be written into logs or source.
 */
export function describeConfig(config: AppConfig): Record<string, string> {
  return {
    env: config.env,
    secretsProvider: config.secretsProviderName,
    wlHost: config.wl.host.length > 0 ? 'set' : 'missing',
    wlAuthHost: config.wl.authHost.length > 0 ? 'set' : 'missing',
    wlIdRegion: 'set',
    wlKBusiness: 'set',
    wlClientId: fingerprint(config.wl.clientId),
    wlClientSecret: fingerprint(config.wl.clientSecret),
    supabaseUrl: config.supabase.url.length > 0 ? 'set' : 'missing',
    supabaseServiceRoleKey: fingerprint(config.supabase.serviceRoleKey),
    ghlHost: config.ghl.host.length > 0 ? 'set' : 'missing',
    ghlVersion: config.ghl.version.length > 0 ? 'set' : 'missing',
    ghlApiToken: fingerprint(config.ghl.apiToken),
    ghlLocationId: fingerprint(config.ghl.locationId),
    logLevel: config.runtime.logLevel,
    maxConcurrency: String(config.runtime.maxConcurrency),
    logToFile: String(config.runtime.logToFile),
    logDir: config.runtime.logDir,
  };
}
