import { randomUUID } from 'node:crypto';

/**
 * Request tracing.
 *
 * TWO IDS, because they answer different questions:
 *
 *   - `traceId` is OURS. Generated for every call, so a line in our log can
 *     always be tied to one request. Never null.
 *   - `kLog` is WL's. Captured when they send it, which is not often - see below.
 *     Null the rest of the time, and null is the honest answer.
 *
 * WHY OURS EXISTS AT ALL. WL's trace id cannot be relied on. Measured against
 * the UAT host on 19 Aug 2026:
 *
 *   - `/v1/business`, `/v1/location/list`, `/v1/staff/list`, `/v1/user`,
 *     `/v1/profile/purchase/list` - HTTP 200, no `k_log` anywhere in the
 *     envelope, and no trace header either.
 *   - `/v1/lead/info` - HTTP 200 WITH a real one, `"[31.77ldu]"`. So it is not
 *     switched off account-wide; it is per endpoint.
 *   - On a real error envelope the nested key exists but the value came back as
 *     the string `"0"`, which is a placeholder rather than an id.
 *
 * So the endpoints this service actually syncs give us nothing to quote, and an
 * internal id is the only thing guaranteed to be there. When WL does send one we
 * record BOTH: theirs is what support can look up, ours is what correlates the
 * rest of our own log.
 *
 * FORMAT: `<runId>.<n>` - eight hex characters for the pass, then a counter, e.g.
 * `a3f9c1d2.7`. The shared prefix is the point: grepping one runId pulls back
 * every call in that sync pass in order, which a bare UUID per call cannot do.
 */

/** Sequence of internal trace ids that share one run prefix. */
export interface TraceIdSource {
  /** Identifies the whole pass. Appears as the prefix of every id it issues. */
  readonly runId: string;
  /** The next id, e.g. `a3f9c1d2.7`. Never returns the same value twice. */
  next: () => string;
}

export interface TraceIdOptions {
  /** Fixed run id, e.g. to correlate with a caller's own. Generated if omitted. */
  runId?: string;
  /** Injectable id source so tests are deterministic. */
  newRunId?: () => string;
}

/** Eight hex characters: short enough to read, wide enough not to collide. */
function defaultRunId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

export function createTraceIds(options: TraceIdOptions = {}): TraceIdSource {
  const runId = options.runId ?? (options.newRunId ?? defaultRunId)();
  let seq = 0;
  return {
    runId,
    next: () => {
      seq += 1;
      return `${runId}.${String(seq)}`;
    },
  };
}

/**
 * Values WL sends in the trace id slot that are not trace ids.
 *
 * `"0"` is the one seen live. Recording it as an id is worse than recording
 * nothing: `null` says "WL gave us nothing", while `"0"` sends support looking
 * for a log entry that does not exist. Deliberately narrow - it matches strings
 * that are ONLY these, so a genuine id like `"[31.77ldu]"` or even `"0abc"`
 * survives.
 */
const PLACEHOLDER = /^(?:0+|-+|null|none|nil|n\/a|undefined)$/i;

function normaliseTraceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return PLACEHOLDER.test(trimmed) ? null : trimmed;
}

/**
 * WL's own trace id, from wherever they put it.
 *
 * Top level on success; on an error buried in the first error's
 * `a_message_source` under the literal key `"[k_log]"` - brackets included.
 */
export function readKLog(body: unknown): string | null {
  const direct = normaliseTraceId(asRecord(body)?.k_log);
  if (direct !== null) return direct;

  const errors = readArray(body, 'a_error');
  const source = errors.length === 0 ? null : asRecord(errors[0])?.a_message_source;
  return normaliseTraceId(asRecord(source)?.['[k_log]']);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readArray(body: unknown, key: string): readonly unknown[] {
  const value = asRecord(body)?.[key];
  return Array.isArray(value) ? value : [];
}
