---
id: 013
title: Supabase write client — PostgREST upsert/insert over fetch
status: done
priority: high
depends_on: []
created: 2026-08-21
---

# Supabase write client — PostgREST upsert/insert over fetch

The prerequisite the M03 writer (010), queue loop (011) and route (012) all assume
but none owns. Today `src/supabase/` holds only `health.ts`, which pings the REST
root — nothing writes.

## Goal

A thin, tested Supabase data-access module for the sync engine: insert, upsert
(on a named conflict target), and select, over PostgREST with the service-role
key. No ORM, no new dependency — `health.ts` already talks REST with `fetch`, and
the same approach covers writes.

## Scope

- `src/supabase/client.ts` (or similar): `insert`, `upsert(table, rows, {onConflict})`,
  `select` against `${SUPABASE_URL}/rest/v1/…` with `apikey` + `Authorization:
  Bearer <service role>` and `Prefer: resolution=merge-duplicates` for upsert.
- Errors: non-2xx becomes a typed error carrying table + status, host redacted
  (a URL/host must not reach a log or a stored record — existing project rule).
- Injectable `fetch` and base URL for tests, matching the client/health pattern.

## Out of scope

- Any table-specific parsing or mapping — that is the writer (010).
- Retry/queue semantics — 011. This layer just does one HTTP call and reports.
- A query builder or migrations runner. YAGNI: the sync engine needs insert,
  upsert, select and nothing more.

## Acceptance criteria

- [ ] `upsert` writes new rows and updates existing ones on the conflict target,
      proven against the live dev DB (a temp row, cleaned up)
- [ ] A non-2xx response raises a typed error naming the table and status, with no
      host or key in the message
- [ ] `SUPABASE_SERVICE_ROLE_KEY` never appears in a log line (it bypasses RLS)
- [ ] Unit tests with an injected fetch; mutation-proven

## Constraints & notes

- Dev env is live and linked (healthcheck green 2026-08-21): real DB available to
  test against. The service-role key bypasses RLS — sync-workers only, never a
  browser path (RUNBOOK).
- No new dependency. If a case genuinely needs `@supabase/supabase-js`, raise it
  rather than adding it silently.
- Register the new file in ARCHITECTURE's file table (docs-current test enforces it).
