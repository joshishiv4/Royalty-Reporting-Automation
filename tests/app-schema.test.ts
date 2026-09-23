import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The schema split, made checkable.
 *
 * 0047 moves the portal's eleven tables into `app` and re-points the fourteen
 * projection functions at them. The danger in that migration is not the move -
 * it is that a plpgsql body resolves its table names when it RUNS. A reference
 * left saying `public.cohort_link` therefore raises nothing at migration time,
 * nothing at deploy time, and then fails the sync's own INSERT days later from
 * inside a trigger.
 *
 * So "did we get every reference" cannot be answered by the migration running
 * cleanly. It is answered here instead: from 0047 onwards, no owned table may
 * be addressed as `public.<name>`, in a literal or in dynamic SQL.
 *
 * WHY A WORD BOUNDARY AND NOT A PLAIN SUBSTRING. `identity` is a prefix of
 * `identity_sync_person`, `attendance_record` of `attendance_record_sync`, and
 * `organization` of `organization_stamp` - all FUNCTIONS, all of which stay in
 * public deliberately. Matching loosely would demand they be moved and make
 * this test wrong rather than strict.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

/** The tables that live in `app` once 0047 has run. */
const OWNED = [
  'organization_membership',
  'class_session_teacher',
  'attendance_record',
  'attendance_link',
  'organization',
  'session_link',
  'cohort_link',
  'class_session',
  'identity',
  'student',
  'teacher',
  'cohort',
  'creation',
];

/**
 * Names that must NEVER appear as `app.<name>`: the WellnessLiving mirror the
 * sync writes, the updated_at trigger the mirror shares, and the projection
 * functions, which stay in public so that "where is this defined" has one
 * answer.
 */
const PUBLIC_ONLY = [
  'person',
  'lead',
  'session',
  'session_staff',
  'attendance',
  'login_type',
  'location',
  'purchase',
  'purchase_item',
  'set_updated_at',
  'wl_teacher',
  'organization_stamp',
];

/**
 * The migrations that run in a world where `app` exists, as the text that is
 * allowed to be judged.
 *
 * 0047 is sliced at its first function definition ON PURPOSE. Everything above
 * that is the move itself - `alter table public.student set schema app` has to
 * name the old schema, that is what moving means - and a check that flagged it
 * would be asking the migration not to do its job. Everything from the first
 * function down is body text that resolves at run time, which is the part that
 * can be silently wrong.
 */
function migrationsFromSplit(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql') && /^\d{4}/.test(f))
    .filter((f) => Number(f.slice(0, 4)) >= 47)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
      if (!name.startsWith('0047')) return { name, sql };
      const at = sql.indexOf('create or replace function');
      expect(at, '0047 defines no function - the re-point is missing').toBeGreaterThan(-1);
      return { name, sql: sql.slice(at) };
    });
}

const boundary = (names: string[], schema: string) =>
  new RegExp(`${schema}[.](${names.join('|')})(?![a-zA-Z0-9_])`, 'g');

describe('the app schema split', () => {
  it('has a 0047 that creates the schema and moves the owned tables', () => {
    const files = readdirSync(MIGRATIONS);
    const split = files.find((f) => f.startsWith('0047'));
    expect(split, 'no 0047 migration - the schema split is missing').toBeDefined();

    const sql = readFileSync(join(MIGRATIONS, split as string), 'utf8');
    expect(sql).toContain('create schema if not exists app');
    // Eleven moves: organization and organization_membership are created in
    // `app` by 0048 rather than moved, so they are not counted here.
    expect((sql.match(/set schema app/g) ?? []).length).toBe(11);
  });

  it('addresses no owned table as public, from 0047 onwards', () => {
    const offenders: string[] = [];
    for (const { name, sql } of migrationsFromSplit()) {
      for (const hit of sql.match(boundary(OWNED, 'public')) ?? []) {
        offenders.push(`${name}: ${hit}`);
      }
      // Dynamic SQL names its schema in a format string, where the table is a
      // %I placeholder and the regex above cannot see it.
      for (const hit of sql.match(/public[.]%I|'public[.]' \|\| /g) ?? []) {
        offenders.push(`${name}: ${hit}`);
      }
    }
    expect(offenders, 'these resolve at RUN time and fail the next sync').toEqual([]);
  });

  it('never moves a WellnessLiving-mirror name into app', () => {
    const offenders: string[] = [];
    for (const { name, sql } of migrationsFromSplit()) {
      for (const hit of sql.match(boundary(PUBLIC_ONLY, 'app')) ?? []) {
        offenders.push(`${name}: ${hit}`);
      }
    }
    expect(offenders, 'app.<mirror table> does not exist and never will').toEqual([]);
  });

  it('points the portal check scripts at app in their catalogue lookups', () => {
    // The miss this catches is worse than a broken query. `where table_schema =
    // 'public' and table_name in ('student', 'teacher')` does not error once
    // those tables live in `app` - it matches nothing, counts zero, and reports
    // PASS. A check that has quietly stopped checking is indistinguishable from
    // one that is satisfied, which is the whole reason it is asserted here.
    const CHECKS = join(ROOT, 'supabase', 'checks');
    const offenders: string[] = [];
    for (const name of ['portal_projection_verify.sql', 'identity_trigger_cases.sql']) {
      const sql = readFileSync(join(CHECKS, name), 'utf8');
      for (const hit of sql.match(/(?:table_schema|schemaname|nspname)\s*=\s*'public'/g) ?? []) {
        offenders.push(`${name}: ${hit}`);
      }
    }
    expect(offenders, 'these report PASS by matching nothing').toEqual([]);
  });

  it('re-points every projection function in the same file as the move', () => {
    const files = readdirSync(MIGRATIONS);
    const split = readFileSync(
      join(MIGRATIONS, files.find((f) => f.startsWith('0047')) as string),
      'utf8',
    );
    // The fourteen from 0040, 0042 and 0044. A move that shipped without them
    // is the silent-break case this whole file exists for.
    expect((split.match(/create or replace function/g) ?? []).length).toBe(14);
  });
});
