import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the acceptance criterion that no credential, host or region value
 * appears anywhere in the committed source.
 *
 * The rules below are PATTERNS, not values: writing the real prod host, region
 * or business id into this test would be the very thing it exists to prevent.
 */
// fileURLToPath, not URL.pathname: on Windows the latter yields "/F:/..." with
// percent-encoded spaces.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Every directory whose committed source must be free of environment values. */
const SCANNED_DIRS = ['src', 'api'];

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    // Anchored on real TLDs, so prose may say WellnessLiving and a settings key
    // may be called "wellnessliving.host", but an actual host cannot appear.
    name: 'a WellnessLiving hostname (must come from WL_API_HOST)',
    pattern: /wellnessliving\.(io|com|net|org|dev|app|co)\b/i,
  },
  {
    name: 'a GoHighLevel hostname (must come from config)',
    pattern: /leadconnectorhq\.(com|io|net)\b/i,
  },
  {
    name: 'a Google API hostname (must come from GOOGLE_OAUTH_HOST / GOOGLE_DRIVE_API_HOST)',
    pattern: /googleapis\.com\b/i,
  },
  {
    name: 'a literal supabase.co project URL (must come from SUPABASE_URL)',
    pattern: /[a-z0-9-]+\.supabase\.(co|in)\b/i,
  },
  {
    name: 'an assigned id_region literal (must come from WL_ID_REGION)',
    pattern: /id_region\s*[=:]\s*['"`]?\d/,
  },
  {
    name: 'an assigned k_business literal (must come from WL_K_BUSINESS)',
    pattern: /k_business\s*[=:]\s*['"`]?\d/,
  },
  {
    name: 'a bare 6+ digit numeric literal (looks like a k_ key or business id)',
    // Allows underscore-separated numbers such as 10_000 used for timeouts.
    pattern: /(?<![\w.])\d{6,}(?![\w_])/,
  },
  {
    name: 'a JWT-shaped string (Supabase legacy anon/service_role key)',
    pattern: /eyJ[A-Za-z0-9_-]{8,}\./,
  },
  {
    name: 'a Supabase secret API key (new sb_secret_ format)',
    pattern: /sb_secret_[A-Za-z0-9_-]{8,}/,
  },
  {
    name: 'a GoHighLevel private integration token',
    pattern: /pit-[0-9a-f]{8}-/i,
  },
  {
    name: 'an OAuth client secret assignment',
    pattern: /client_secret\s*[=:]\s*['"`][^'"`<]{6,}/i,
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('committed source contains no environment values', () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  it('scans every source directory, including the deployed api/ handlers', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const dir of SCANNED_DIRS) {
      expect(
        files.some((f) => relative(ROOT, f).split(sep)[0] === dir),
        `no files scanned in ${dir}/`,
      ).toBe(true);
    }
  });

  it.each(RULES)('contains no $name', ({ pattern }) => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          const shown = relative(ROOT, file).split(sep).join('/');
          offenders.push(`${shown}:${String(index + 1)}`);
        }
      });
    }

    expect(offenders, `matched at: ${offenders.join(', ')}`).toEqual([]);
  });
});
