import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GhlClient } from '../src/ghl/client.js';
import { GHL_PATHS } from '../src/ghl/endpoint.js';

/**
 * Enforces the acceptance criterion "the client exposes no create or update
 * capability at all" AS A PROPERTY OF THE CODE, not as a promise in a comment.
 *
 * The tests below are meant to fail if a future change loosens the client. A
 * shape check is the point: a code-review promise fades, a build failure does
 * not.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function readSource(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

describe('GhlClient is read-only by construction', () => {
  it('exposes exactly one public surface: searchContacts', () => {
    const publicMethods = Object.getOwnPropertyNames(GhlClient.prototype).filter(
      (name) => name !== 'constructor' && !name.startsWith('_'),
    );
    expect(publicMethods).toEqual(['searchContacts']);
  });

  it('lists exactly one endpoint path, and it is the search path', () => {
    expect(Object.keys(GHL_PATHS)).toEqual(['contactsSearch']);
    expect(GHL_PATHS.contactsSearch).toMatch(/search/);
  });

  it('never sends a mutating HTTP verb', () => {
    const source = readSource('src/ghl/client.ts');
    // A search POST is fine and expected; PUT/PATCH/DELETE never are.
    expect(source).not.toMatch(/method\s*:\s*['"]PUT['"]/i);
    expect(source).not.toMatch(/method\s*:\s*['"]PATCH['"]/i);
    expect(source).not.toMatch(/method\s*:\s*['"]DELETE['"]/i);
  });

  it('has no create/update/delete-shaped method names anywhere in the module', () => {
    const source = readSource('src/ghl/client.ts');
    // Method declarations only - the word appearing in prose (this comment
    // included, if it survived) is fine.
    const bannedMethod = /\b(create|update|delete|upsert|patch|remove|save)[A-Z]\w*\s*\(/;
    expect(bannedMethod.test(source)).toBe(false);
  });

  it('the source directory contains only the expected files', () => {
    // A new file appearing here should be a deliberate design decision, not an
    // incidental helper that starts drifting toward a write path. matcher.ts
    // was added for PRD M04; it decides WHICH contact a person is and calls
    // nothing but searchContacts, so it inherits the read-only guarantee rather
    // than widening it.
    const dir = fileURLToPath(new URL('../src/ghl/', import.meta.url));
    const entries = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .sort();
    expect(entries).toEqual(['client.ts', 'endpoint.ts', 'health.ts', 'matcher.ts', 'retry.ts']);
    expect(ROOT).toBeTruthy();
  });

  // The claim made in the comment above, enforced: the matcher may only ever
  // reach GoHighLevel through the one read-only method.
  it('the matcher touches GoHighLevel only through searchContacts', () => {
    const source = readSource('src/ghl/matcher.ts');
    expect(source).not.toMatch(/[^a-zA-Z]fetch\s*\(/);
    expect(source).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
    // The only GHL capability it names.
    expect(source).toMatch(/searchContacts/);
  });
});
