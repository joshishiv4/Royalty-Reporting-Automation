import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/logging/logger.js';
import {
  credentialValues,
  describeConfig,
  fingerprint,
  redact,
  REDACTED,
} from '../src/logging/redact.js';
import { FAKE_BUNDLES, FakeProvider } from './helpers/fixtures.js';

const loadFake = () =>
  loadConfig({ processEnv: { APP_ENV: 'prod' }, provider: new FakeProvider() });

describe('redact', () => {
  it('removes every known credential, including repeats', () => {
    const output = redact('token=abcdefgh12 again abcdefgh12', ['abcdefgh12']);
    expect(output).toBe(`token=${REDACTED} again ${REDACTED}`);
  });

  it('removes the longest match first so nested values do not survive', () => {
    const output = redact('value=abcdefgh12345', ['abcdefgh12345', 'abcdefgh12']);
    expect(output).toBe(`value=${REDACTED}`);
  });

  it('ignores values too short to be a credential', () => {
    expect(redact('id=1', ['1'])).toBe('id=1');
  });
});

describe('fingerprint', () => {
  it('reveals no usable portion of a real-length secret', () => {
    const secret = 'prod-service-role-key-0000';
    const printed = fingerprint(secret);
    expect(printed).not.toContain(secret);
    expect(printed).toContain('len 26');
  });

  it('redacts short values entirely', () => {
    expect(fingerprint('short')).toContain(REDACTED);
  });
});

describe('describeConfig', () => {
  it('prints no credential, host, region or business id', async () => {
    const config = await loadFake();
    const printed = JSON.stringify(describeConfig(config));

    for (const value of [
      FAKE_BUNDLES.prod.WL_API_HOST,
      FAKE_BUNDLES.prod.WL_K_BUSINESS,
      FAKE_BUNDLES.prod.WL_CLIENT_SECRET,
      FAKE_BUNDLES.prod.SUPABASE_SERVICE_ROLE_KEY,
      FAKE_BUNDLES.prod.GHL_API_TOKEN,
    ]) {
      expect(printed, value).not.toContain(value);
    }
    expect(printed).toContain('"env":"prod"');
  });
});

describe('createLogger', () => {
  it('scrubs credentials that arrive inside a field or an error', async () => {
    const config = await loadFake();
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      secrets: credentialValues(config),
      write: (line) => lines.push(line),
    });

    logger.error('call failed', {
      url: `https://x/?token=${config.ghl.apiToken}`,
      err: new Error(`rejected key ${config.supabase.serviceRoleKey}`),
    });

    const output = lines.join('\n');
    expect(output).not.toContain(config.ghl.apiToken);
    expect(output).not.toContain(config.supabase.serviceRoleKey);
    expect(output).toContain(REDACTED);
  });

  it('honours the level threshold', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });
    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('shown');
    logger.error('shown');
    expect(lines).toHaveLength(2);
  });

  it('emits one JSON object per line', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
    logger.info('hello', { n: 1 });

    // `time` is stamped on every line: a log file without one is far less use
    // when reconstructing a failed overnight run.
    const { time, ...rest } = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(rest).toEqual({ level: 'info', msg: 'hello', n: 1 });
    expect(Number.isNaN(Date.parse(String(time)))).toBe(false);
  });
});
