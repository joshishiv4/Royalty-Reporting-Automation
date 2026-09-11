import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createDefaultFileSinks, createFileSink } from '../src/logging/file-sink.js';
import { createLogger } from '../src/logging/logger.js';
import { FakeProvider } from './helpers/fixtures.js';

/**
 * Log files are the one place a leaked credential outlives the process, so the
 * redaction assertions here matter more than the plumbing ones.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'royalty-logs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readLines = (name: string): string[] =>
  readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);

describe('log files', () => {
  it('writes info and error lines to app.log', () => {
    const logger = createLogger({
      level: 'info',
      write: () => undefined,
      sinks: createDefaultFileSinks(dir),
    });

    logger.info('sync started', { env: 'dev' });
    logger.error('step failed', { step: 'staff' });

    const lines = readLines('app.log');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'info', msg: 'sync started' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ level: 'error', msg: 'step failed' });
  });

  it('keeps error.log to errors only, so a failed run reads clean', () => {
    const logger = createLogger({
      level: 'debug',
      write: () => undefined,
      sinks: createDefaultFileSinks(dir),
    });

    logger.debug('noise');
    logger.info('more noise');
    logger.warn('nearly');
    logger.error('the actual problem');

    expect(readLines('app.log')).toHaveLength(4);
    const errors = readLines('error.log');
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0] ?? '{}')).toMatchObject({ msg: 'the actual problem' });
  });

  it('stamps every line with a timestamp', () => {
    const logger = createLogger({ level: 'info', write: () => undefined, sinks: [] });
    const lines: string[] = [];
    const withFile = createLogger({
      level: 'info',
      write: (line) => lines.push(line),
      sinks: createDefaultFileSinks(dir),
    });
    logger.info('ignored');
    withFile.info('stamped');

    const entry = JSON.parse(readLines('app.log')[0] ?? '{}') as { time?: string };
    expect(typeof entry.time).toBe('string');
    expect(Number.isNaN(Date.parse(entry.time ?? ''))).toBe(false);
  });

  it('honours the level threshold before anything reaches a file', () => {
    const logger = createLogger({
      level: 'warn',
      write: () => undefined,
      sinks: createDefaultFileSinks(dir),
    });

    logger.info('should not be written');
    logger.warn('should be written');

    const lines = readLines('app.log');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('should be written');
  });

  it('NEVER writes a credential to disk', async () => {
    const config = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: new FakeProvider(),
    });
    const secret = config.wl.clientSecret;
    expect(secret.length).toBeGreaterThan(0);

    const logger = createLogger({
      level: 'info',
      secrets: [secret],
      write: () => undefined,
      sinks: createDefaultFileSinks(dir),
    });

    logger.error('auth failed', { attemptedWith: secret });

    const raw = readFileSync(join(dir, 'app.log'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED]');
    // The errors-only file is a second copy on disk; it must be scrubbed too.
    expect(readFileSync(join(dir, 'error.log'), 'utf8')).not.toContain(secret);
  });

  it('creates the directory when it does not exist yet', () => {
    const nested = join(dir, 'deep', 'nested');
    const logger = createLogger({
      level: 'info',
      write: () => undefined,
      sinks: [createFileSink({ dir: nested, name: 'app.log' })],
    });

    logger.info('first line');

    expect(readFileSync(join(nested, 'app.log'), 'utf8')).toContain('first line');
  });

  it('rotates by size and keeps a bounded number of generations', () => {
    const sink = createFileSink({ dir, name: 'app.log', maxBytes: 200, maxFiles: 2 });
    const logger = createLogger({ level: 'info', write: () => undefined, sinks: [sink] });

    for (let i = 0; i < 40; i += 1) logger.info(`line ${String(i)} padded out to force rotation`);

    const files = readdirSync(dir).sort();
    // The live file plus at most maxFiles generations - never unbounded.
    expect(files).toEqual(['app.log', 'app.log.1', 'app.log.2']);
  });

  it('does not fail the caller when the sink cannot write', () => {
    // A file where the directory should be: mkdir and append both fail.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');

    const logger = createLogger({
      level: 'info',
      write: () => undefined,
      sinks: [createFileSink({ dir: blocked, name: 'app.log' })],
    });

    // A logging problem must never be the reason a sync pass dies.
    expect(() => {
      logger.info('still runs');
    }).not.toThrow();
  });

  it('still writes to the console when a file sink is attached', () => {
    const console: string[] = [];
    const logger = createLogger({
      level: 'info',
      write: (line) => console.push(line),
      sinks: createDefaultFileSinks(dir),
    });

    logger.info('both places');

    expect(console).toHaveLength(1);
    expect(readLines('app.log')).toHaveLength(1);
  });
});

describe('log file configuration', () => {
  it('is off by default, so serverless is unaffected', async () => {
    const config = await loadConfig({
      processEnv: { APP_ENV: 'dev' },
      provider: new FakeProvider(),
    });
    expect(config.runtime.logToFile).toBe(false);
    expect(config.runtime.logDir).toBe('logs');
  });

  it('reads LOG_TO_FILE and LOG_DIR from the environment', async () => {
    const config = await loadConfig({
      processEnv: { APP_ENV: 'dev', LOG_TO_FILE: 'true', LOG_DIR: '/var/log/royalty' },
      provider: new FakeProvider(),
    });
    expect(config.runtime.logToFile).toBe(true);
    expect(config.runtime.logDir).toBe('/var/log/royalty');
  });

  it('accepts 1 and 0 as well', async () => {
    const on = await loadConfig({
      processEnv: { APP_ENV: 'dev', LOG_TO_FILE: '1' },
      provider: new FakeProvider(),
    });
    expect(on.runtime.logToFile).toBe(true);
  });

  it('rejects a misspelled flag rather than silently disabling logging', async () => {
    await expect(
      loadConfig({
        processEnv: { APP_ENV: 'dev', LOG_TO_FILE: 'yes' },
        provider: new FakeProvider(),
      }),
    ).rejects.toThrow(/LOG_TO_FILE/);
  });
});
