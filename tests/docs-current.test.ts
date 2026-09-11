import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Makes the documentation rule real.
 *
 * CLAUDE.md says every file under src/ and api/ must be named in
 * docs/ARCHITECTURE.md, and every migration must appear in its migration table.
 * A rule nothing checks is a preference, and preferences lose to deadlines - so
 * this fails the build instead.
 *
 * The bar is deliberately low: the file path has to APPEAR. This cannot tell
 * whether the sentence next to it is any good, and does not pretend to. What it
 * does stop is a module landing with no mention anywhere, which is the failure
 * that actually happens - nobody omits a doc on purpose, they just forget.
 *
 * Fixing a failure is one line in the nearest table in ARCHITECTURE.md.
 */

// fileURLToPath, not URL.pathname: on Windows the latter yields "/F:/..." with
// percent-encoded spaces.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function readDoc(name: string): string {
  return readFileSync(join(ROOT, 'docs', name), 'utf8');
}

/** Every .ts file under a directory, as a forward-slashed repo-relative path. */
function sourceFiles(dir: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((entry) => {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });

  return walk(join(ROOT, dir))
    .map((f) => relative(ROOT, f).split('\\').join('/'))
    .sort();
}

describe('the docs keep up with the code', () => {
  it('names every file in src/ and api/ in ARCHITECTURE.md', () => {
    const architecture = readDoc('ARCHITECTURE.md');
    const files = [...sourceFiles('src'), ...sourceFiles('api')];

    // Sanity check on the walker itself: an empty list would make this test pass
    // for the wrong reason forever.
    expect(files.length).toBeGreaterThan(10);

    const unregistered = files.filter((f) => !architecture.includes(f));

    expect(
      unregistered,
      `Add these to a table in docs/ARCHITECTURE.md:\n  ${unregistered.join('\n  ')}`,
    ).toEqual([]);
  });

  it('lists every migration in the ARCHITECTURE migration table', () => {
    const architecture = readDoc('ARCHITECTURE.md');
    const migrations = readdirSync(join(ROOT, 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    expect(migrations.length).toBeGreaterThan(0);

    // Matched on the numeric prefix - the table reads `0007`, not the full
    // filename, and renaming a migration's description should not fail a test.
    const unlisted = migrations.filter((f) => {
      const prefix = f.split('_')[0];
      return prefix === undefined || !architecture.includes(prefix);
    });

    expect(
      unlisted,
      `Add these to the migration table in docs/ARCHITECTURE.md:\n  ${unlisted.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps every doc cross-link pointing at something that exists', () => {
    const docs = ['ARCHITECTURE.md', 'DATA-MODEL.md', 'STATUS.md', 'WL-API-NOTES.md'];
    const broken: string[] = [];

    for (const doc of docs) {
      const body = readDoc(doc);
      // Relative markdown links only - external URLs and anchors are not ours
      // to verify.
      for (const match of body.matchAll(/\]\((?!https?:)([^)#\s]+)/g)) {
        const target = match[1];
        if (target === undefined) continue;
        try {
          statSync(join(ROOT, 'docs', target));
        } catch {
          broken.push(`docs/${doc} -> ${target}`);
        }
      }
    }

    expect(broken, `Broken links:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  it('has a STATUS.md carrying a date, so staleness is visible', () => {
    const status = readDoc('STATUS.md');

    // A status file without a date gets believed indefinitely. This does not
    // check the date is recent - only that someone has to look at it.
    expect(status).toMatch(/Last updated\s+\*\*\d{1,2}\s+\w+\s+\d{4}\*\*/);
  });
});
