/**
 * A small, read-only Jotform REST client (task 038, phase 2).
 *
 * THE ONE THING IT DOES is list a form's submissions. No create, edit or delete
 * surface - the sign-off flow only ever reads what parents submitted. The host is
 * configuration (JOTFORM_API_HOST) and never appears in an error message; the key
 * travels in the `APIKEY` header, never in the URL, so it cannot reach a log line
 * through a printed URL.
 *
 * SUCCESS IS THE BODY AND THE STATUS. Jotform answers `{ responseCode, message,
 * content }`; a 200 whose responseCode is not 200 is a failure, as with WL.
 */

export interface JotformClientConfig {
  readonly apiHost: string;
  readonly apiKey: string;
}

export interface JotformClientDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** One answer as Jotform returns it, keyed by question id in `answers`. */
export interface JotformAnswer {
  readonly name?: string;
  readonly type?: string;
  readonly answer?: unknown;
  readonly prettyFormat?: unknown;
}

export interface JotformSubmission {
  readonly id: string;
  readonly form_id?: string;
  readonly status?: string;
  readonly created_at?: string;
  readonly answers?: Readonly<Record<string, JotformAnswer>>;
}

export class JotformRequestError extends Error {
  constructor(
    message: string,
    /** Path only - the host is configuration. */
    readonly path: string,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = 'JotformRequestError';
  }
}

export class JotformClient {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: JotformClientConfig,
    deps: JotformClientDeps = {},
  ) {
    this.doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = deps.timeoutMs ?? 30_000;
  }

  /**
   * One page of a form's submissions, newest first.
   *
   * Newest first so the caller can stop at the first page that holds a submission
   * it has already stored - one call an hour in the normal case, with no reliance
   * on Jotform's `created_at` filter, whose times carry no offset (US Eastern, measured).
   */
  async listSubmissions(
    formId: string,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<JotformSubmission[]> {
    const path = `/form/${encodeURIComponent(formId)}/submissions`;
    const query = new URLSearchParams({
      offset: String(page.offset),
      limit: String(page.limit),
      orderby: 'created_at',
    });
    const content = await this.#get(path, query);
    if (!Array.isArray(content)) {
      throw new JotformRequestError('Jotform submissions: content is not a list', path, 200);
    }
    return content.filter(isSubmission);
  }

  // #private: unreachable from outside, so no caller can point it elsewhere.
  async #get(path: string, query: URLSearchParams): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`https://${this.config.apiHost}${path}?${query.toString()}`, {
        method: 'GET',
        headers: { APIKEY: this.config.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new JotformRequestError(`Jotform request failed (${reason})`, path, null);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new JotformRequestError('Jotform answered with a non-JSON body', path, response.status);
    }
    const envelope = body as { responseCode?: unknown; message?: unknown; content?: unknown };
    if (!response.ok || envelope.responseCode !== 200) {
      const message = typeof envelope.message === 'string' ? envelope.message : 'no message';
      throw new JotformRequestError(
        `Jotform error ${String(typeof envelope.responseCode === 'number' ? envelope.responseCode : response.status)}: ${message}`,
        path,
        response.status,
      );
    }
    return envelope.content;
  }
}

function isSubmission(value: unknown): value is JotformSubmission {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}
