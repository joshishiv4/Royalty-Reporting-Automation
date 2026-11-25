import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import { runtimeOptionsSchema } from '../src/config/schema.js';
import { DriveClient, driveQueryString, type DriveRequestError } from '../src/google/drive.js';
import { credentialValues, scrubMessage } from '../src/logging/redact.js';

const OAUTH_HOST = 'oauth.example.test';
const API_HOST = 'drive.example.test';
const CONFIG = {
  oauthHost: OAUTH_HOST,
  apiHost: API_HOST,
  clientId: 'test-client-id-0123456789',
  clientSecret: 'test-client-secret-0123456789',
  refreshToken: 'test-refresh-token-0123456789',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const TOKEN = { access_token: 'test-access-token-0123456789', expires_in: 3600 };

/** A fetch that answers the token endpoint with TOKEN and everything else from `drive`. */
function fakeFetch(drive: (url: string, init?: RequestInit) => Response) {
  return vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = input as string;
    return Promise.resolve(
      url.startsWith(`https://${OAUTH_HOST}/`) ? json(TOKEN) : drive(url, init),
    );
  });
}

const tokenCalls = (fetch: ReturnType<typeof fakeFetch>) =>
  fetch.mock.calls.filter(([u]) => (u as string).startsWith(`https://${OAUTH_HOST}/`));

describe('DriveClient', () => {
  it('exchanges the refresh token in the body, then sends only the access token', async () => {
    const fetch = fakeFetch(() => json({ files: [{ id: 'f1', name: 'a.pdf' }] }));
    const drive = new DriveClient(CONFIG, { fetch });

    expect(await drive.listFiles("name = 'a.pdf'")).toEqual([{ id: 'f1', name: 'a.pdf' }]);

    const [tokenUrl, tokenInit] = fetch.mock.calls[0] ?? [];
    expect(tokenUrl).toBe(`https://${OAUTH_HOST}/token`);
    expect(tokenInit?.method).toBe('POST');
    const form = new URLSearchParams(tokenInit?.body as string);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(CONFIG.refreshToken);
    expect(form.get('client_secret')).toBe(CONFIG.clientSecret);

    const [listUrl, listInit] = fetch.mock.calls[1] ?? [];
    expect(listUrl as string).toMatch(new RegExp(`^https://${API_HOST}/drive/v3/files\\?`));
    for (const secret of [CONFIG.refreshToken, CONFIG.clientSecret, TOKEN.access_token]) {
      expect(listUrl as string).not.toContain(secret);
    }
    expect((listInit?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN.access_token}`,
    );
  });

  it('reuses the access token until near its expiry, then refreshes it', async () => {
    let clock = 0;
    const fetch = fakeFetch(() => json({ files: [] }));
    const drive = new DriveClient(CONFIG, { fetch, now: () => clock });

    await drive.listFiles('x');
    await drive.listFiles('x');
    expect(tokenCalls(fetch)).toHaveLength(1);

    clock = 3600 * 1000 - 30_000; // inside the last minute of the hour
    await drive.listFiles('x');
    expect(tokenCalls(fetch)).toHaveLength(2);
  });

  it('follows nextPageToken to the end of a listing', async () => {
    const fetch = fakeFetch((url) =>
      new URL(url).searchParams.get('pageToken') === 'p2'
        ? json({ files: [{ id: 'f2', name: 'b' }] })
        : json({ files: [{ id: 'f1', name: 'a' }], nextPageToken: 'p2' }),
    );
    const drive = new DriveClient(CONFIG, { fetch });
    expect((await drive.listFiles('x')).map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('moves, renames and tags a file in ONE request', async () => {
    const fetch = fakeFetch(() => json({ id: 'f1', name: 'Test-Student.pdf', parents: ['dest'] }));
    const drive = new DriveClient(CONFIG, { fetch });

    await drive.moveFile('f1', {
      fromParent: 'inbox',
      toParent: 'dest',
      name: 'Test-Student.pdf',
      appProperties: { lessonSignoffId: 'L1' },
    });

    const driveCalls = fetch.mock.calls.filter(([u]) => (u as string).includes(API_HOST));
    expect(driveCalls).toHaveLength(1);
    const [url, init] = driveCalls[0] ?? [];
    const params = new URL(url as string).searchParams;
    expect(init?.method).toBe('PATCH');
    expect(params.get('addParents')).toBe('dest');
    expect(params.get('removeParents')).toBe('inbox');
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'Test-Student.pdf',
      appProperties: { lessonSignoffId: 'L1' },
    });
  });

  it('a Drive error names the path and status, never the host', async () => {
    const fetch = fakeFetch(() =>
      json({ error: { code: 404, message: 'File not found: f1.' } }, 404),
    );
    const drive = new DriveClient(CONFIG, { fetch });
    const error = (await drive
      .moveFile('f1', { fromParent: 'a', toParent: 'b', name: 'n', appProperties: {} })
      .catch((e: unknown) => e)) as DriveRequestError;
    expect(error.message).toBe('Drive error 404: File not found: f1.');
    expect(error.path).toBe('/drive/v3/files/f1');
    expect(error.message).not.toContain(API_HOST);
  });

  // The failure a Google app left in "Testing" produces after 7 days.
  it('a refused refresh token is a clear error with no secret in it', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        ),
      );
    const drive = new DriveClient(CONFIG, { fetch });
    const error = (await drive.listFiles('x').catch((e: unknown) => e)) as DriveRequestError;
    expect(error.message).toBe(
      'Google token refresh failed: invalid_grant (Token has been expired or revoked.)',
    );
    for (const leak of [OAUTH_HOST, CONFIG.refreshToken, CONFIG.clientSecret]) {
      expect(error.message).not.toContain(leak);
    }
    expect(fetch).toHaveBeenCalledTimes(1); // no Drive call without a token
  });

  it('a 200 without the expected body is an error, not an empty result', async () => {
    const drive = new DriveClient(CONFIG, { fetch: fakeFetch(() => json({ kind: 'drive#x' })) });
    await expect(drive.listFiles('x')).rejects.toThrow('Drive list: no files array');
  });
});

describe('driveQueryString', () => {
  it("escapes quotes and backslashes - FI names like It's My Place", () => {
    expect(driveQueryString("It's My Place - NOVEMBER 2026")).toBe(
      "'It\\'s My Place - NOVEMBER 2026'",
    );
    expect(driveQueryString('a\\b')).toBe("'a\\\\b'");
  });
});

describe('Google settings', () => {
  const parse = (env: Record<string, string>) => runtimeOptionsSchema.parse(env);

  it('hosts must be bare, folder ids must not be URLs, empty is unset', () => {
    expect(() => parse({ GOOGLE_OAUTH_HOST: `https://${OAUTH_HOST}/` })).toThrow();
    expect(() => parse({ GOOGLE_DRIVE_API_HOST: `${API_HOST}/drive` })).toThrow();
    expect(() =>
      parse({ GOOGLE_DRIVE_INBOX_FOLDER_ID: 'https://drive.example.test/drive/folders/abc' }),
    ).toThrow();
    expect(parse({ GOOGLE_DRIVE_ROOT_FOLDER_ID: '1AbC_d-9' }).GOOGLE_DRIVE_ROOT_FOLDER_ID).toBe(
      '1AbC_d-9',
    );
    expect(parse({ GOOGLE_REFRESH_TOKEN: '' }).GOOGLE_REFRESH_TOKEN).toBeUndefined();
  });

  it('the client id, secret and refresh token are scrubbed; the hosts are named', () => {
    const config = {
      signoff: { drive: { ...CONFIG, inboxFolderId: null, rootFolderId: null } },
    } as unknown as AppConfig;
    const values = credentialValues(config);
    expect(values).toEqual(
      expect.arrayContaining([CONFIG.clientId, CONFIG.clientSecret, CONFIG.refreshToken]),
    );
    const scrubbed = scrubMessage(
      `POST ${OAUTH_HOST} refresh=${CONFIG.refreshToken} secret=${CONFIG.clientSecret} then ${API_HOST}`,
      config,
    );
    for (const leak of [OAUTH_HOST, API_HOST, CONFIG.refreshToken, CONFIG.clientSecret]) {
      expect(scrubbed).not.toContain(leak);
    }
    expect(scrubbed).toContain('[GOOGLE_OAUTH_HOST]');
    expect(scrubbed).toContain('[GOOGLE_DRIVE_API_HOST]');
  });
});
