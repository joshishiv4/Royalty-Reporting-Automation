import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { LogLevel } from '../config/schema.js';

/**
 * Log files on disk, one line of JSON per entry.
 *
 * Lines arrive here ALREADY REDACTED - createLogger scrubs known credential
 * values before handing anything to a sink, and that ordering is the whole
 * reason the sink interface takes a formatted string rather than fields. A sink
 * that formatted its own payload could reintroduce a secret that the console
 * never showed, and a file is the one place a leak persists after the process
 * exits.
 *
 * WRITES ARE SYNCHRONOUS, on purpose. A crashing sync pass is exactly when the
 * log matters most, and an async write queued behind the failure is a log entry
 * that never lands. The volume here is a few hundred lines per pass, so the cost
 * is irrelevant next to the WL calls it is describing.
 *
 * ROTATION is by size, keeping a fixed number of generations, so an unattended
 * cron cannot fill the disk. `app.log` becomes `app.log.1`, `.1` becomes `.2`,
 * and the oldest is dropped.
 *
 * NOT FOR SERVERLESS. On Vercel the filesystem is read-only apart from /tmp, and
 * /tmp does not survive the invocation - so file logging is opt-in via
 * LOG_TO_FILE and stays off by default. Deployed environments should read the
 * platform's own log stream, which is what stderr is for.
 */

export interface LogSink {
  /** Receives one already-redacted, already-serialised line. */
  write: (line: string) => void;
  /** Lines below this level are not passed to this sink. */
  minLevel?: LogLevel;
}

export interface FileSinkOptions {
  /** Directory for log files. Relative paths resolve from cwd. */
  dir: string;
  /** File name, e.g. `app.log`. */
  name: string;
  /** Rotate once the file passes this size. Default 5 MB. */
  maxBytes?: number;
  /** How many rotated generations to keep, beyond the live file. Default 5. */
  maxFiles?: number;
  /** Only write lines at or above this level. */
  minLevel?: LogLevel;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

/**
 * A sink that appends to `<dir>/<name>`, rotating by size.
 *
 * Failures to write are swallowed deliberately: a full disk or a read-only
 * mount must not take down a sync pass that is otherwise succeeding. The
 * failure is reported once on stderr rather than on every line, so a broken
 * sink cannot itself become the flood.
 */
export function createFileSink(options: FileSinkOptions): LogSink {
  const dir = isAbsolute(options.dir) ? options.dir : resolve(process.cwd(), options.dir);
  const file = join(dir, options.name);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  let ready = false;
  let reportedFailure = false;

  const reportOnce = (error: unknown): void => {
    if (reportedFailure) return;
    reportedFailure = true;
    const reason = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(
      `log file ${options.name} is not writable, continuing without it: ${reason}\n`,
    );
  };

  const sink: LogSink = {
    write: (line: string): void => {
      try {
        if (!ready) {
          mkdirSync(dir, { recursive: true });
          ready = true;
        }
        rotateIfNeeded(file, maxBytes, maxFiles);
        appendFileSync(file, `${line}\n`, 'utf8');
      } catch (error) {
        reportOnce(error);
      }
    },
  };
  return options.minLevel === undefined ? sink : { ...sink, minLevel: options.minLevel };
}

function rotateIfNeeded(file: string, maxBytes: number, maxFiles: number): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return; // No file yet: nothing to rotate.
  }
  if (size < maxBytes) return;

  // Drop the oldest, then shift each generation up by one.
  rmSync(`${file}.${String(maxFiles)}`, { force: true });
  for (let i = maxFiles - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${file}.${String(i)}`, `${file}.${String(i + 1)}`);
    } catch {
      // That generation does not exist yet.
    }
  }
  renameSync(file, `${file}.1`);
}

/**
 * The standard pair: everything at the configured level, plus an errors-only
 * file so a failed run can be read without wading through the successful calls
 * around it.
 */
export function createDefaultFileSinks(dir: string): LogSink[] {
  return [
    createFileSink({ dir, name: 'app.log' }),
    createFileSink({ dir, name: 'error.log', minLevel: 'error' }),
  ];
}
