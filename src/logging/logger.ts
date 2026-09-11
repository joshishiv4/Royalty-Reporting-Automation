import { LOG_LEVELS, type LogLevel } from '../config/schema.js';
import type { LogSink } from './file-sink.js';
import { redact } from './redact.js';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Credential values to scrub from every line. See credentialValues(). */
  secrets?: readonly string[];
  /** Sink override; defaults to stderr so stdout stays machine-readable. */
  write?: (line: string) => void;
  /**
   * Extra destinations, e.g. log files. Each receives the SAME already-redacted
   * line the console gets - a sink never sees fields it could format itself,
   * which is what stops a transport reintroducing a scrubbed credential.
   *
   * A sink that throws is dropped rather than allowed to fail the caller: a log
   * write must never be the reason a sync pass dies.
   */
  sinks?: readonly LogSink[];
}

/**
 * A minimal structured logger that scrubs known credentials from every line.
 *
 * Deliberately dependency-free and sink-injectable: the redaction guarantee is
 * only worth something if it cannot be bypassed by a transport that formats
 * fields itself.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const threshold = LEVEL_RANK[options.level];
  const secrets = options.secrets ?? [];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const sinks = options.sinks ?? [];

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const payload = {
      level,
      msg: message,
      time: new Date().toISOString(),
      ...(fields ?? {}),
    };
    // Redact ONCE, then fan out. Every destination gets the same scrubbed text.
    const line = redact(safeStringify(payload), secrets);
    write(line);
    for (const sink of sinks) {
      if (sink.minLevel !== undefined && LEVEL_RANK[level] < LEVEL_RANK[sink.minLevel]) continue;
      try {
        sink.write(line);
      } catch {
        // A broken sink is not worth failing a run over, and it has already
        // reported itself once on stderr.
      }
    }
  };

  const logger = {} as Record<LogLevel, Logger[LogLevel]>;
  for (const level of LOG_LEVELS) {
    logger[level] = (message: string, fields?: Record<string, unknown>) =>
      emit(level, message, fields);
  }
  return logger;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replaceUnserialisable);
  } catch {
    return JSON.stringify({ level: 'error', msg: 'log payload could not be serialised' });
  }
}

function replaceUnserialisable(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
