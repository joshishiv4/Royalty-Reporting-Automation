import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import { runtimeOptionsSchema } from '../src/config/schema.js';
import { JotformClient, type JotformRequestError } from '../src/jotform/client.js';
import { credentialValues, scrubMessage } from '../src/logging/redact.js';

const KEY = 'test-jotform-api-key-0123456789';
const HOST = 'api.example.test';

function respond(body: unknown, status = 200) {
  return vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('JotformClient.listSubmissions', () => {
  it('sends the key as a header, never in the URL', async () => {
    const fetch = respond({ responseCode: 200, message: 'success', content: [{ id: '9001' }] });
    const client = new JotformClient({ apiHost: HOST, apiKey: KEY }, { fetch });

    const subs = await client.listSubmissions('42', { offset: 0, limit: 100 });

    expect(subs).toEqual([{ id: '9001' }]);
    const [input, init] = fetch.mock.calls[0] ?? [];
    const url = input as string;
    expect(url).toBe(`https://${HOST}/form/42/submissions?offset=0&limit=100&orderby=created_at`);
    expect(url).not.toContain(KEY);
    expect((init?.headers as Record<string, string>).APIKEY).toBe(KEY);
    expect(init?.method).toBe('GET');
  });

  // Like WL: the status line is not the verdict, the body is.
  it('a 200 whose responseCode is not 200 is an error', async () => {
    const client = new JotformClient(
      { apiHost: HOST, apiKey: KEY },
      { fetch: respond({ responseCode: 401, message: 'You are not authorized' }) },
    );
    // The envelope's own code and message - not a later "content is not a list".
    await expect(client.listSubmissions('42', { offset: 0, limit: 1 })).rejects.toThrow(
      'Jotform error 401: You are not authorized',
    );
  });

  it('an error names the path, never the host', async () => {
    const client = new JotformClient(
      { apiHost: HOST, apiKey: KEY },
      { fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed')) },
    );
    const error = (await client
      .listSubmissions('42', { offset: 0, limit: 1 })
      .catch((e: unknown) => e)) as JotformRequestError;
    expect(error.path).toBe('/form/42/submissions');
    expect(error.message).not.toContain(HOST);
  });

  it('drops entries that are not submissions', async () => {
    const client = new JotformClient(
      { apiHost: HOST, apiKey: KEY },
      { fetch: respond({ responseCode: 200, content: [{ id: '1' }, { nope: true }, null] }) },
    );
    expect(await client.listSubmissions('42', { offset: 0, limit: 10 })).toEqual([{ id: '1' }]);
  });
});

describe('JotformClient.getSubmission (task 039)', () => {
  it('reads one submission by id, the key in the header only', async () => {
    const fetch = respond({
      responseCode: 200,
      content: { id: '9001', form_id: '42', answers: {} },
    });
    const client = new JotformClient({ apiHost: HOST, apiKey: KEY }, { fetch });

    expect(await client.getSubmission('9001')).toEqual({ id: '9001', form_id: '42', answers: {} });
    const [input, init] = fetch.mock.calls[0] ?? [];
    expect(input).toBe(`https://${HOST}/submission/9001`);
    expect(input as string).not.toContain(KEY);
    expect((init?.headers as Record<string, string>).APIKEY).toBe(KEY);
  });

  // An id from a webhook body is outside input: it must not be able to change the path.
  it('encodes the id, so it cannot walk to another endpoint', async () => {
    const fetch = respond({ responseCode: 200, content: { id: 'x' } });
    const client = new JotformClient({ apiHost: HOST, apiKey: KEY }, { fetch });
    await client.getSubmission('../user');
    expect(fetch.mock.calls[0]?.[0] as string).toContain('/submission/..%2Fuser');
  });

  it('content that is not a submission is an error, not an empty answer', async () => {
    const client = new JotformClient(
      { apiHost: HOST, apiKey: KEY },
      { fetch: respond({ responseCode: 200, content: [] }) },
    );
    await expect(client.getSubmission('9001')).rejects.toThrow('content is not a submission');
  });

  it('a Jotform error (e.g. no such submission) is thrown with its own message', async () => {
    const client = new JotformClient(
      { apiHost: HOST, apiKey: KEY },
      { fetch: respond({ responseCode: 404, message: 'Submission not found' }, 404) },
    );
    await expect(client.getSubmission('1')).rejects.toThrow(
      'Jotform error 404: Submission not found',
    );
  });
});

describe('Jotform settings', () => {
  const parse = (env: Record<string, string>) => runtimeOptionsSchema.parse(env);

  // An unset GitHub secret arrives as "" - it must mean the default, not an error.
  it('SIGNOFF_TIMEZONE: empty means America/New_York; a bad zone is refused', () => {
    expect(parse({ SIGNOFF_TIMEZONE: '' }).SIGNOFF_TIMEZONE).toBe('America/New_York');
    expect(parse({}).SIGNOFF_TIMEZONE).toBe('America/New_York');
    expect(parse({ SIGNOFF_TIMEZONE: 'Asia/Kolkata' }).SIGNOFF_TIMEZONE).toBe('Asia/Kolkata');
    expect(() => parse({ SIGNOFF_TIMEZONE: 'Mars/Olympus' })).toThrow();
  });

  it('JOTFORM_API_HOST must be a bare host', () => {
    expect(() => parse({ JOTFORM_API_HOST: 'https://api.example.test/' })).toThrow();
    expect(parse({ JOTFORM_API_KEY: '' }).JOTFORM_API_KEY).toBeUndefined();
  });

  it('the API key is a credential: scrubbed from logs, and the hosts are named', () => {
    const config = {
      signoff: { apiKey: KEY, apiHost: HOST, formHost: 'form.example.test' },
    } as unknown as AppConfig;
    expect(credentialValues(config)).toContain(KEY);
    const scrubbed = scrubMessage(`GET ${HOST} failed with key ${KEY}`, config);
    expect(scrubbed).not.toContain(KEY);
    expect(scrubbed).not.toContain(HOST);
    expect(scrubbed).toContain('[JOTFORM_API_HOST]');
  });
});
