---
id: 007
title: Apply the health-views/RLS migration to the live DB and run its isolation proof
status: done
priority: high
depends_on: []
created: 2026-08-21
---

# Apply the health-views/RLS migration to the live DB and run its isolation proof

## Goal

`0010_health_views_and_rls.sql` is written, committed (`8b2f0a8`) and green in CI,
but the code was verified only on paper — the vitest suite mocks `fetch` and never
touches Postgres. `docs/STATUS.md:60` still records the migration as "written, not
applied". Until it is applied and the isolation proof is run against the real
database, "RLS enforces access" is an assertion, not a fact. This task closes that
gap: apply once, prove enforcement, and correct the stale docs.

## Scope

- Apply [`supabase/migrations/0010_health_views_and_rls.sql`](../../../supabase/migrations/0010_health_views_and_rls.sql)
  to the live Supabase database.
- Run both read-only checks against the live DB:
  - [`supabase/checks/rls_bypass_check.sql`](../../../supabase/checks/rls_bypass_check.sql)
  - [`supabase/checks/rls_isolation_test.sql`](../../../supabase/checks/rls_isolation_test.sql)
- Update `docs/STATUS.md` (line ~60) to reflect applied + proven, with the date.
- Fix `Tasks/index.md`, which currently claims "No tasks yet" while 001–007 exist.

## Out of scope

- Any change to the migration's SQL — it is verified correct on static review.
- The blocked teacher-cost / `enrollment_margin` margin piece (WL exposes no pay
  amounts; see the migration header). Revenue-only reporting is expected here.
- Write policies. Every policy in 0010 is SELECT-only by design; the portal reads.

## Acceptance criteria

- [x] 0010 is applied to the live DB (all four views exist, five SELECT policies
      present, `security_invoker = on` on all views)
- [x] `rls_isolation_test.sql` prints four `PASS` notices and `ALL PASSED`; the
      trailing "test data gone" select returns zero rows
- [x] `rls_bypass_check.sql` shows the five policies and every view with
      `security_invoker` on (not `OFF - BYPASSES RLS`)
- [x] `docs/STATUS.md` shows Health views and RLS as applied, dated
- [x] `Tasks/index.md` lists the real tasks

## Constraints & notes

- The scripts are meant for the Supabase SQL editor or a direct Postgres
  connection. `.env` has only `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (REST) —
  **no Postgres connection string / DB password**, and there is no Supabase CLI
  installed. Getting a DB connection (or SQL-editor access) is the prerequisite and
  the reason this is a task rather than a one-liner already run.
- `rls_isolation_test.sql` inserts two test people, proves isolation, and rolls
  back — nothing is persisted. Safe to run against prod.
- Requires 0010's `person.auth_user_id` column and policies to already be applied,
  so apply the migration before running the isolation test.

## Resources

*None yet — the migration and check scripts live in `supabase/`, linked above.*
