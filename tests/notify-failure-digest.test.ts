import { describe, expect, it } from 'vitest';
import { buildDigest, type DeadItem } from '../src/notify/failure-digest.js';

/**
 * The digest is the load-bearing piece of the SMTP notification: it turns a
 * queue row into a sentence a non-technical reader can act on. These tests pin
 * down every rule an inbox actually depends on.
 */

function item(overrides: Partial<DeadItem> = {}): DeadItem {
  return {
    work_type: 'purchase_receipt',
    target_key: 'k-1',
    last_error: 'something broke',
    last_error_sid: null,
    last_http_status: 500,
    attempt_count: 4,
    ...overrides,
  };
}

describe('buildDigest', () => {
  it('sends nothing when there are no dead items - a healthy run does not email', () => {
    const digest = buildDigest([]);
    expect(digest.hasIssues).toBe(false);
    expect(digest.subject).toBe('');
    expect(digest.body).toBe('');
  });

  it('groups items by (stage, reason) so the same pattern reads once, not per row', () => {
    const digest = buildDigest([
      item({ work_type: 'purchase_receipt', target_key: 'k-1', last_http_status: 504 }),
      item({ work_type: 'purchase_receipt', target_key: 'k-2', last_http_status: 504 }),
      item({ work_type: 'purchase_receipt', target_key: 'k-3', last_http_status: 504 }),
    ]);
    expect(digest.hasIssues).toBe(true);
    // Three items, ONE line in the body.
    const bulletLines = digest.body.split('\n').filter((l) => l.startsWith('• '));
    expect(bulletLines).toHaveLength(1);
    expect(bulletLines[0]).toContain('3 record(s)');
    expect(bulletLines[0]).toContain('purchase receipts');
  });

  it('uses a friendly stage name, not the work_type key', () => {
    const digest = buildDigest([
      item({ work_type: 'ghl_contact_match', last_http_status: 500, last_error_sid: null }),
    ]);
    expect(digest.body).toContain('GoHighLevel contact matching');
    // The internal key never reaches the reader.
    expect(digest.body).not.toContain('ghl_contact_match');
  });

  it('translates id-nx to a plain-English sentence a non-technical reader can act on', () => {
    const digest = buildDigest([
      item({
        last_error_sid: 'id-nx',
        last_error: 'The ID value for k_purchase does not exist',
        last_http_status: 200,
      }),
    ]);
    expect(digest.body).toContain('does not exist');
    expect(digest.body.toLowerCase()).toContain('deleted');
    // No sid, no http status, no trace id in the BODY.
    expect(digest.body).not.toContain('id-nx');
    expect(digest.body).not.toContain('200');
    expect(digest.body).not.toContain('k_purchase');
  });

  it('translates 401/403 to a plain-English credentials sentence', () => {
    const digest = buildDigest([item({ last_http_status: 401, last_error_sid: null })]);
    expect(digest.body.toLowerCase()).toContain('authentication');
    expect(digest.body).not.toContain('401');
  });

  it('translates 502/504 to a plain-English "server was slow" sentence', () => {
    const digest = buildDigest([item({ last_http_status: 504, last_error_sid: null })]);
    expect(digest.body.toLowerCase()).toContain('slow');
    expect(digest.body).not.toContain('504');
  });

  it('falls back to a "forward to engineering" message on an unknown failure shape', () => {
    const digest = buildDigest([
      item({
        last_error: 'obscure error nobody has patterned yet',
        last_error_sid: 'weird-sid',
        last_http_status: 418,
      }),
    ]);
    expect(digest.body.toLowerCase()).toContain('engineering');
  });

  it('the subject names the total count of records', () => {
    const digest = buildDigest([
      item({ target_key: 'a', last_http_status: 500 }),
      item({ target_key: 'b', last_http_status: 500 }),
      item({ target_key: 'c', last_http_status: 500 }),
    ]);
    expect(digest.subject).toContain('3 record(s)');
  });

  it('shows up to three sample target_keys per group, with an "and more" hint above that', () => {
    const dead = Array.from({ length: 10 }, (_, i) =>
      item({ target_key: `key-${String(i)}`, last_http_status: 504 }),
    );
    const digest = buildDigest(dead);
    expect(digest.body).toContain('key-0');
    expect(digest.body).toContain('key-2');
    // 4th sample not shown; "and more" is present.
    expect(digest.body).not.toContain('key-3');
    expect(digest.body).toContain('and more');
  });

  it('reads the same across the whole body: everyday language, no jargon', () => {
    const digest = buildDigest([
      item({ work_type: 'client_visits', last_http_status: 504, last_error_sid: null }),
    ]);
    // Words a non-technical reader recognises.
    expect(digest.body).toMatch(/\b(records?|reason|slow|retry|later)\b/i);
    // Sids and status codes never appear in the body.
    expect(digest.body).not.toMatch(/\b(sid|http|status|traceid)\b/i);
  });
});
