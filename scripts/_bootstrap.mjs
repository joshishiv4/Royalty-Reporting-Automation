/**
 * Shared start-up for the operator scripts in this directory.
 *
 * WHY A LOADER AND NOT `node --env-file`. These scripts are run by whoever is
 * on call, from a fresh clone, often against prod. `--env-file` fails silently
 * on a missing file and the script then reads whatever happens to be in the
 * ambient environment - which, on a machine that has both, is the wrong
 * environment about half the time. Reading the file explicitly means a missing
 * or unreadable .env stops the script instead of quietly retargeting it.
 *
 * The scripts import from `dist/`, so `npm run build` has to have been run.
 * That is checked here rather than surfacing as a module-not-found stack.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(2);
}

if (!existsSync(fileURLToPath(new URL('dist/config/index.js', root)))) {
  die('dist/ is missing or stale. Run `npm run build` first.');
}

const envPath = new URL('.env', root);
if (!existsSync(fileURLToPath(envPath))) {
  die('No .env in the repository root. Copy .env.example and fill it in - see docs/RUNBOOK.md.');
}

for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  // Ambient wins, so `APP_ENV=prod node scripts/...` overrides the file.
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { loadConfig } = await import(new URL('dist/config/index.js', root).href);
const { SupabaseClient } = await import(new URL('dist/supabase/client.js', root).href);

export const config = await loadConfig();
export const db = new SupabaseClient(config.supabase);
export const kBusiness = config.wl.kBusiness;

/**
 * Printed by every script before it does anything.
 *
 * WHICH ENVIRONMENT AM I POINTED AT is the question behind most operator
 * mistakes, and the answer must not require reading the source. The business
 * id is shown because dev and prod carry different ones; the host is not,
 * because a host must never reach a log or a terminal transcript that gets
 * pasted into a ticket.
 */
export function banner(what) {
  console.log(`\n${what}  ·  env=${config.env}  ·  business=${kBusiness}\n`);
}

/** `--flag=value` / `--flag` parsing, so each script does not reinvent it. */
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? true;
    else out._.push(a);
  }
  return out;
}

/** PostgREST caps a read; page until short. `selectAll` refuses its own limit. */
export async function selectPaged(table, query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await db.select(table, `${query}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
