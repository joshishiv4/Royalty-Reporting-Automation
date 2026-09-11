# Progress: Apply the health-views/RLS migration to the live DB and run its isolation proof

## Checklist

- [ ] Obtain a live Postgres connection or Supabase SQL-editor access
- [ ] Apply `0010_health_views_and_rls.sql`
- [ ] Run `rls_bypass_check.sql`, confirm policies + `security_invoker` on all views
- [ ] Run `rls_isolation_test.sql`, confirm four `PASS` + `ALL PASSED`
- [ ] Update `docs/STATUS.md:60` to applied + proven, dated
- [ ] Regenerate `Tasks/index.md`

## Last step

Not yet started.

## Blockers

No DB connection available from the working environment — `.env` has REST creds
only (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), no Postgres URL/password, no
Supabase CLI. Needs SQL-editor access or a connection string to proceed.

## Log

### 2026-08-21
- Task created. Migration `0010` confirmed committed (`8b2f0a8`) and green in CI
  (212/212 vitest), but verified only on paper — suite mocks `fetch`, never hits
  Postgres. `STATUS.md:60` still reads "written, not applied". No duplicate task
  exists (001–006 are all WL API-client work).

### 2026-08-21 — blocked on DB connection access
- Cannot execute from here: applying 0010 is DDL (CREATE VIEW / POLICY), and the
  isolation checks are SQL scripts (DO blocks, RAISE NOTICE). Neither runs over
  PostgREST, which is the only Supabase access in .env (SUPABASE_URL + service key).
- Unblock with EITHER: (a) a Postgres connection string (DATABASE_URL) — psql is
  installed locally, so the migration + both checks can run from here; OR (b) run
  0010 and supabase/checks/{rls_bypass_check,rls_isolation_test}.sql in the Supabase
  SQL editor and paste the notices back.

### 2026-08-21 — done (applied + proven live)
- 0010 applied via the Supabase SQL editor (no DB password available for psql).
- Bypass check: 5 SELECT policies (person/purchase/purchase_item/attendance/session,
  all scoped to authenticated); all 6 views security_invoker = on.
- Isolation test PASSED after a harness fix: the temp table used `on commit drop`,
  which the SQL editor dropped between statements (ERROR 42P01). Inlined the two test
  people as VALUES; re-run completed with no error and the "test data gone" select
  returned 0 rows.
- STATUS updated: Health views and RLS = applied + proven.
