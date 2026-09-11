# Progress: Supabase write client — PostgREST upsert/insert over fetch

## Checklist

- [x] insert/upsert/select helpers over PostgREST with the service-role key
- [x] typed, host-redacted error on non-2xx
- [x] injectable fetch + base URL; unit tests, mutation-proven
- [x] prove upsert against the live dev DB with a temp row, then clean up
- [x] register the file in ARCHITECTURE

## Last step

Not yet started. Unblocked: dev env is live (healthcheck green), all tables present.

## Blockers

None. This is the first codeable step of M03.

## Log

### 2026-08-21
- Created after the dev env was confirmed live end to end: WL auth + fetch (20 staff,
  purchases path) and Supabase REST (service key accepted, all 8 tables present).
  This is the write layer 010/011/012 depend on.

### 2026-08-21 — done
- src/supabase/client.ts: insert/upsert/select over PostgREST, typed SupabaseError,
  host+key redacted. 6 unit tests (injected fetch) + live upsert idempotency proof
  against dev sync_run (insert→update→1 row→cleanup 204). Mutation-verified redaction.
- Added to ARCHITECTURE file table and the wl-error-200 fetch allowlist.
- npm run verify: 228 tests green.
