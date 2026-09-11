# Progress: M03c — resume cursor, sync_run accounting, and route wiring

## Checklist

- [ ] Add sync_job_state cursor + report_handle resume
- [ ] Write one sync_run per invocation (ok/partial/failed)
- [ ] Rewire api/wellness-sync.ts to a bounded slice
- [ ] Move STATUS off 'not started' with the date

## Last step

Not yet started.

## Blockers

None on access — dev env is live (healthcheck green 2026-08-21): WL auth + fetch
and Supabase REST all confirmed, all 8 tables present. Blocked only on the task(s)
in depends_on landing first.

## Log

### 2026-08-21
- Created as an M03 sub-task when PRD 009 was green-lit. Decisions live in 009.

### 2026-08-21 — done
- src/sync/pass.ts: runStaffSyncPass — opens sync_run, seeds + drains the queue in a
  budget loop, closes with ok/partial/failed. partial (budget hit, work eligible) is
  distinct from failed. Route rewired: failed->503, ok/partial->200.
- 3 pass unit tests (fakes) + route status-mapping tests (pass mocked) + live proof:
  runStaffSyncPass against dev -> state ok, sync_run row with finished_at/token_fetches,
  staff written, cleanup PASS. Mutation-verified the partial verdict.
- Deferred: sync_job_state page cursor (no paginated job yet — lands with 014) and
  sync_conflict creation. STATUS moved M03 to "in progress — staff path live".
