/**
 * A small Google Drive client (task 038, phase 3) - the only module that talks
 * to Google.
 *
 * WHAT IT CAN DO: list files matching a query, create a folder, and move/rename
 * a file. No delete, no trash, no upload, no permission change - phase 3 only
 * files PDFs that Jotform already put in Drive. Phase 4's merge will add an
 * upload here, deliberately and with its own tests.
 *
 * WHO IT ACTS AS. A Google USER (the studio's account), through an OAuth refresh
 * token - not a service account. A service account has no storage quota of its
 * own, so it cannot create files in a My Drive folder, which phase 4's merged
 * PDFs need. See RUNBOOK.md for how the token is made.
 *
 * NO SECRET LEAVES THIS FILE. The refresh token and client secret go only into
 * the token request body; the access token only into the Authorization header.
 * Hosts are configuration (GOOGLE_OAUTH_HOST, GOOGLE_DRIVE_API_HOST) and never
 * appear in an error message - errors carry the path only, as with Jotform.
 *
 * SUCCESS IS THE STATUS AND THE BODY. Google answers errors with a non-2xx and
 * `{ error: { code, message } }` (Drive) or `{ error, error_description }` (the
 * token endpoint); a 2xx without the field the caller needs is a failure too.
 */

export interface DriveClientConfig {
  readonly oauthHost: string;
  readonly apiHost: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export interface DriveClientDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly parents?: readonly string[];
  readonly createdTime?: string;
  readonly appProperties?: Readonly<Record<string, string>>;
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

const FILE_FIELDS = 'id,name,parents,createdTime,appProperties';
/** Refresh this long before Google's stated expiry, so a request never races it. */
const TOKEN_EARLY_MS = 60_000;
/** A runaway guard on one listing: 20 pages of 100 is far beyond any folder here. */
const MAX_LIST_PAGES = 20;

export class DriveRequestError extends Error {
  constructor(
    message: string,
    /** Path only - the host is configuration. */
    readonly path: string,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = 'DriveRequestError';
  }
}

/**
 * A string literal for a Drive `q` expression: single quotes around it, and
 * backslash and quote escaped. FI titles like "It's My Place" need this.
 */
export function driveQueryString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export class DriveClient {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: DriveClientConfig,
    deps: DriveClientDeps = {},
  ) {
    this.doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = deps.timeoutMs ?? 30_000;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Every file matching a Drive `q` expression, oldest first. Includes shared drives. */
  async listFiles(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        orderBy: 'createdTime',
        pageSize: '100',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken !== null) query.set('pageToken', pageToken);
      const body = (await this.#request('GET', '/drive/v3/files', query)) as {
        files?: unknown;
        nextPageToken?: unknown;
      };
      if (!Array.isArray(body.files)) {
        throw new DriveRequestError('Drive list: no files array', '/drive/v3/files', 200);
      }
      out.push(...body.files.filter(isDriveFile));
      if (typeof body.nextPageToken !== 'string' || body.nextPageToken === '') return out;
      pageToken = body.nextPageToken;
    }
    throw new DriveRequestError('Drive list: too many pages', '/drive/v3/files', 200);
  }

  /** Creates a folder inside `parentId` and returns it. */
  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    const query = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' });
    const body = await this.#request('POST', '/drive/v3/files', query, {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    });
    if (!isDriveFile(body)) {
      throw new DriveRequestError('Drive create: no file in the answer', '/drive/v3/files', 200);
    }
    return body;
  }

  /**
   * Moves a file from one folder to another, renames it and sets its
   * appProperties - in ONE request, so the file is never half-filed.
   */
  async moveFile(
    fileId: string,
    move: {
      readonly fromParent: string;
      readonly toParent: string;
      readonly name: string;
      readonly appProperties: Readonly<Record<string, string>>;
    },
  ): Promise<DriveFile> {
    const path = `/drive/v3/files/${encodeURIComponent(fileId)}`;
    const query = new URLSearchParams({
      addParents: move.toParent,
      removeParents: move.fromParent,
      fields: FILE_FIELDS,
      supportsAllDrives: 'true',
    });
    const body = await this.#request('PATCH', path, query, {
      name: move.name,
      appProperties: move.appProperties,
    });
    if (!isDriveFile(body)) {
      throw new DriveRequestError('Drive move: no file in the answer', path, 200);
    }
    return body;
  }

  // #private: unreachable from outside, so no caller can point it elsewhere.
  async #request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    query: URLSearchParams,
    json?: unknown,
  ): Promise<unknown> {
    const token = await this.#accessToken();
    let response: Response;
    try {
      response = await this.doFetch(`https://${this.config.apiHost}${path}?${query.toString()}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new DriveRequestError(`Drive request failed (${reason})`, path, null);
    }
    const body = await readJson(response, path);
    if (!response.ok) {
      const e = (body as { error?: { message?: unknown } } | null)?.error;
      const message = typeof e?.message === 'string' ? e.message : 'no message';
      throw new DriveRequestError(
        `Drive error ${String(response.status)}: ${message}`,
        path,
        response.status,
      );
    }
    return body;
  }

  /** A cached access token, refreshed from the refresh token when near expiry. */
  async #accessToken(): Promise<string> {
    if (this.token !== null && this.now() < this.token.expiresAt) return this.token.value;
    const path = '/token';
    let response: Response;
    try {
      response = await this.doFetch(`https://${this.config.oauthHost}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new DriveRequestError(`Google token request failed (${reason})`, path, null);
    }
    const body = (await readJson(response, path)) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_description?: unknown;
    } | null;
    if (!response.ok || typeof body?.access_token !== 'string') {
      // `invalid_grant` here is the usual one: a revoked token, or an app left in
      // Google's "Testing" status, whose refresh tokens die after 7 days.
      const code = typeof body?.error === 'string' ? body.error : 'no error code';
      const detail =
        typeof body?.error_description === 'string' ? ` (${body.error_description})` : '';
      throw new DriveRequestError(
        `Google token refresh failed: ${code}${detail}`,
        path,
        response.status,
      );
    }
    const lifetimeS = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + lifetimeS * 1000 - TOKEN_EARLY_MS,
    };
    return this.token.value;
  }
}

async function readJson(response: Response, path: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DriveRequestError('Google answered with a non-JSON body', path, response.status);
  }
}

function isDriveFile(value: unknown): value is DriveFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}
