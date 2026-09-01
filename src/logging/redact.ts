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
    // Optional access on purpose. This is called from the ERROR path, where a
    // config may be half-built precisely because building it is what failed - and
    // a scrubber that throws turns a diagnosable failure into an opaque crash.
    config.wl?.clientId,
    config.wl?.clientSecret,
    config.supabase?.serviceRoleKey,
    config.ghl?.apiToken,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
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
    // The notifier's on/off switch is worth reporting: "why did nobody get an
    // email" is otherwise answered by opening a dashboard. The password is
    // fingerprinted like any other credential - never printed.
    smtpHost: config.smtp.host === null ? 'missing' : 'set',
    smtpPassword: fingerprint(config.smtp.password),
  };
}

/**
 * An error message safe to STORE, with the reason intact.
 *
 * WHY THIS EXISTS. `sync_run.error` used to be written as `error.name`, so every
 * failure in every pass was recorded as the bare word "SupabaseError" or
 * "WlRequestError" and the reason was discarded. That is not a small loss: two
 * real bugs today - a column sent to a table that does not have it, and two
 * migrations missing from the live database - both surfaced only as
 * "SupabaseError" and looked exactly like an ordinary partial run. Diagnosing
 * them took hours of reproducing by hand what the row already knew and threw away.
 *
 * The reason it was thrown away is real, though: a raw message can carry a host
 * (an undici connect error names it), and a host must never reach a stored record.
 * So this SCRUBS rather than discards - credentials become [REDACTED], every
 * configured host is replaced by name, and anything still URL-shaped is reduced to
 * its path. `PGRST204: Could not find the 'id_visit' column of 'session'` survives
 * that intact, which is the whole point.
 */
export function scrubMessage(message: string, config: AppConfig): string {
  try {
    return scrub(message, config);
  } catch {
    // Belt and braces. If scrubbing itself fails we must still not leak, so the
    // message is dropped rather than passed through - but the caller keeps the
    // error's name, which is more than it had before this existed.
    return '[unscrubbable message]';
  }
}

function scrub(message: string, config: AppConfig): string {
  let out = redact(message, credentialValues(config));

  // Configured hosts by name, so the reader knows WHICH host without learning it.
  for (const [label, host] of [
    ['[WL_API_HOST]', config.wl?.host ?? ''],
    ['[WL_AUTH_HOST]', config.wl?.authHost ?? ''],
    ['[GHL_API_HOST]', config.ghl?.host ?? ''],
  ] as const) {
    if (host.length > 0) out = out.split(host).join(label);
  }
  const supabaseUrl = config.supabase?.url ?? '';
  if (supabaseUrl.length > 0) {
    out = out.split(supabaseUrl).join('[SUPABASE_URL]');
    // The bare host too: a message may name it without the scheme.
    const bare = supabaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (bare.length > 0) out = out.split(bare).join('[SUPABASE_HOST]');
  }

  // Anything still URL-shaped keeps its path and loses its origin. A host this
  // process was never configured with is still a host.
  out = out.replace(/https?:\/\/[^\s/]+(\/[^\s]*)?/g, (_m, path: string | undefined) =>
    path === undefined || path === '' ? '[URL]' : `[URL]${path}`,
  );

  return out.length > 500 ? `${out.slice(0, 500)}...` : out;
}
