import type { SupabaseConfig } from '../config/schema.js';

/**
 * The Supabase data path for the sync engine.
 *
 * PostgREST over `fetch`, nothing more. The service writes with the service-role
 * key, so this is a trusted server-side path - never a browser one. There is no
 * ORM and no query builder on purpose: the writer needs insert, upsert and
 * select, and a fourth verb is a fourth thing to test.
 *
 * TWO RULES CARRIED FROM THE REST OF THE PROJECT:
 *
 *   - The host never reaches a log or an error message. A network failure is
 *     reported by its error class only, because the URL is configuration.
 *   - The service-role key bypasses RLS. It is a header here and nowhere else;
 *     it is never formatted into a message.
 */

export interface SupabaseClientDeps {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface UpsertOptions {
  /**
   * The unique column(s) PostgREST resolves a conflict on, e.g. `"uid"` or
   * `"k_purchase,item_index"`. Required for a real upsert: without it PostgREST
   * cannot tell an update from a duplicate-key error.
   */
  readonly onConflict: string;
}

/** A Supabase write or read that PostgREST rejected, or that never completed. */
export class SupabaseError extends Error {
  constructor(
    readonly table: string,
    readonly httpStatus: number | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SupabaseError';
  }

  /**
   * True when a retry could plausibly succeed: a network failure or timeout
   * (`httpStatus` null), a 429, a 408, or any 5xx - the transient pressure a
   * free-tier database shows under concurrent load. A 4xx (a constraint, a bad
   * column) is a real bug that no amount of retrying fixes, so it stays fatal and
   * surfaces rather than being quietly requeued forever.
   */
  get isTransient(): boolean {
    return (
      this.httpStatus === null ||
      this.httpStatus === 408 ||
      this.httpStatus === 429 ||
      this.httpStatus >= 500
    );
  }
}

/**
 * How many rows selectAll pulls per request.
 *
 * PostgREST's own default cap is 1,000 and asking for more in one request does
 * not raise it, so this matches it rather than guessing higher.
 */
const SELECT_PAGE = 1000;

/**
 * How many rows go in one POST body.
 *
 * 500 rather than PostgREST's read cap: a write row is far wider than the one
 * or two columns a seed reads back, and the limit that bites first is body size
 * and statement time, not a row count.
 */
const WRITE_CHUNK = 500;

export class SupabaseClient {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: SupabaseConfig,
    deps: SupabaseClientDeps = {},
  ) {
    // Bound to globalThis: an unbound fetch reference throws in some runtimes.
    this.doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = deps.timeoutMs ?? 30_000;
  }

  /** Inserts rows and returns them as stored (ids and defaults filled in). */
  async insert<T = Record<string, unknown>>(
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Promise<T[]> {
    return this.write<T>(table, rows, 'return=representation', '');
  }

  /**
   * Calls a Postgres function.
   *
   * Used where SQL can express something PostgREST cannot. The queue's
   * `enqueue_sync_items` is the case that forced it: its uniqueness rule is a
   * PARTIAL unique index, and probed live against this database, every route
   * PostgREST offers fails - a plain insert and `resolution=ignore-duplicates`
   * both raise 23505 (the latter infers the PRIMARY KEY, a generated uuid, which
   * never conflicts), and naming the index columns as `on_conflict` raises 42P10
   * because inferring a partial index requires repeating its WHERE clause. Only
   * raw SQL can write a bare `ON CONFLICT DO NOTHING`.
   */
  async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const response = await this.send(fn, `${this.config.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    // A scalar-returning function answers with the bare value, not an array.
    return this.parseValue<T>(fn, response);
  }

  /**
   * Upserts rows on `options.onConflict` and returns them as stored.
   *
   * Idempotent: a row already present is updated in place, not duplicated. This
   * is what lets a sync re-run without piling up copies of the same record.
   */
  async upsert<T = Record<string, unknown>>(
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
    options: UpsertOptions,
  ): Promise<T[]> {
    return this.write<T>(
      table,
      rows,
      'resolution=merge-duplicates,return=representation',
      `?on_conflict=${encodeURIComponent(options.onConflict)}`,
    );
  }

  /**
   * Patches rows matching `query` and returns the ones actually changed.
   *
   * The returned array is the compare-and-swap the queue claim relies on: a
   * conditional filter (`state=eq.pending`) that matches nothing means another
   * worker got there first, and the empty result says so without a second read.
   */
  async update<T = Record<string, unknown>>(
    table: string,
    patch: Record<string, unknown>,
    query: string,
  ): Promise<T[]> {
    const response = await this.send(table, `${this.base(table)}?${query}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    return this.parse<T>(table, response);
  }

  /**
   * Deletes rows matching `query`. Used for the delete-then-insert idempotency of
   * tables with no natural key (a purchase's payment rows), so re-running a
   * receipt does not pile up duplicate payments.
   */
  async delete(table: string, query: string): Promise<void> {
    const response = await this.send(table, `${this.base(table)}?${query}`, { method: 'DELETE' });
    await this.parse(table, response); // surfaces a typed error on non-2xx
  }

  /**
   * Selects rows with a raw PostgREST query string, e.g. `"uid=eq.123&limit=1"`.
   * Kept deliberately thin - the caller writes the filter it needs.
   */
  async select<T = Record<string, unknown>>(table: string, query = ''): Promise<T[]> {
    const suffix = query.length === 0 ? '' : `?${query}`;
    const response = await this.send(table, `${this.base(table)}${suffix}`, { method: 'GET' });
    return this.parse<T>(table, response);
  }

  /**
   * Selects EVERY matching row, paging until a short page comes back.
   *
   * WHY THIS EXISTS. PostgREST answers a query with no explicit limit by
   * returning at most 1,000 rows, with HTTP 200 and no indication that anything
   * was left behind. A caller that reads a growing table and believes it got
   * everything therefore fails silently - which is the worst shape a failure can
   * take, because the run reports success.
   *
   * This has cost this project twice, measured on live dev:
   *
   *   - receipt_sync seeded 1,000 of 14,148 unpriced purchases and reported 'ok'
   *     with pricing coverage stalled near 30%.
   *   - four person-driven seeds read 1,000 of 1,285 clients once the client list
   *     began storing every status (0027), so 285 clients were invisible to
   *     profile, purchase, visit and GoHighLevel-match seeding while
   *     sync_queue_progress showed every work type at 100%.
   *
   * AN ORDER IS REQUIRED, NOT OPTIONAL. Offset paging over an unordered result
   * is undefined: Postgres may return rows in a different order between pages,
   * so a row can be visited twice or skipped entirely. Demanding `order=` makes
   * that a startup error rather than a wrong answer that looks right. Order by
   * something unique - a primary key - because a non-unique sort key has the same
   * problem within a tie.
   */
  async selectAll<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
    if (!query.includes('order=')) {
      throw new SupabaseError(
        table,
        null,
        'selectAll requires an order= in the query: offset paging over an ' +
          'unordered result can skip or repeat rows',
      );
    }
    if (/(?:^|&)limit=/.test(query)) {
      throw new SupabaseError(
        table,
        null,
        'selectAll sets its own limit and offset; remove them from the query',
      );
    }

    const out: T[] = [];
    for (let offset = 0; ; offset += SELECT_PAGE) {
      const page = await this.select<T>(
        table,
        `${query}&limit=${String(SELECT_PAGE)}&offset=${String(offset)}`,
      );
      out.push(...page);
      // A short page is the only reliable end marker: PostgREST sends no total
      // unless asked, and asking costs a count over the whole table.
      if (page.length < SELECT_PAGE) return out;
    }
  }

  private async write<T>(
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
    prefer: string,
    querySuffix: string,
  ): Promise<T[]> {
    // Nothing to write is not an error, and an empty POST is a wasted round trip.
    if (rows.length === 0) return [];

    // CHUNKED, because a caller cannot know how big its batch will get. The
    // purchase-item element seed enqueues one row per item - 20,561 on live dev -
    // and a single POST of that many JSON objects is a multi-megabyte body
    // against a statement timeout. Splitting it turns a request that fails whole
    // into requests that succeed in sequence, and the failure mode of a partial
    // run is already handled: every write here is an insert of fresh rows or an
    // upsert on a natural key, so a re-run finishes what a broken one started.
    const out: T[] = [];
    for (let start = 0; start < rows.length; start += WRITE_CHUNK) {
      const response = await this.send(table, `${this.base(table)}${querySuffix}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: prefer },
        body: JSON.stringify(rows.slice(start, start + WRITE_CHUNK)),
      });
      out.push(...(await this.parse<T>(table, response)));
    }
    return out;
  }

  private base(table: string): string {
    return `${this.config.url}/rest/v1/${table}`;
  }

  private async send(
    table: string,
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await this.doFetch(url, {
        method: init.method,
        headers: {
          apikey: this.config.serviceRoleKey,
          Authorization: `Bearer ${this.config.serviceRoleKey}`,
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // Network failure or timeout. The message can carry the host, so only the
      // error class is reported.
      throw new SupabaseError(table, null, describeFetchFailure(cause, this.timeoutMs), { cause });
    }
  }

  private async parse<T>(table: string, response: Response): Promise<T[]> {
    const raw = await response.text();
    if (!response.ok) {
      // PostgREST error bodies are query-level (a constraint name, a bad column),
      // not network-level, so they carry no host. Surface the code and message to
      // make the failure actionable; fall back to the status alone.
      const err = parseJson(raw);
      const code = readString(err, 'code');
      const message = readString(err, 'message');
      const detail =
        message === null
          ? `HTTP ${String(response.status)}`
          : `${code === null ? '' : `${code}: `}${message}`;
      throw new SupabaseError(table, response.status, detail);
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }

  /**
   * The same response handling, but returning the body as it came.
   *
   * parse() coerces a non-array to [], which is right for a table read and wrong
   * for a function: a scalar-returning function answers with the bare value, and
   * flattening `7` to `[]` would silently report "nothing queued".
   */
  private async parseValue<T>(name: string, response: Response): Promise<T> {
    const rows = await this.parse<unknown>(name, response.clone());
    if (rows.length > 0) return rows[0] as T;
    return parseJson(await response.text()) as T;
  }
}

function describeFetchFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return `timed out after ${String(timeoutMs)}ms`;
    }
    return cause.name;
  }
  return 'unknown error';
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
