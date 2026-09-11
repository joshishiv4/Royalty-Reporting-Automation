# Progress: sync_job_state — per-job progress and the clean-completion watermark

## Checklist

- [ ] job-state module: openJobState / closeJobState (upsert on job_name+k_business)
- [ ] Wire into runPass alongside sync_run
- [ ] Unit tests: idle+watermark on ok, paused+watermark-untouched on partial, failed
- [ ] Live proof against dev
- [ ] Docs: ARCHITECTURE file table, STATUS P4.3

## Last step

Not yet started.

## Blockers

None. Dev is live; queue/pass (011/012) done.

## Log

### 2026-08-21
- Created to close P4.3 at the job level. Deliberately excludes the page cursor
  (page_number/report_handle) — no paginated endpoint consumes it yet.

### 2026-08-21 — done
- src/sync/job-state.ts: openJobState (running) + closeJobState (idle/paused/failed),
  upsert on (job_name,k_business). Watermark last_clean_completion_at moves ONLY on a
  clean drain. Wired into runPass alongside sync_run.
- 7 unit tests + live proof: staff pass ok -> idle + watermark set; receipt pass with
  a 1ms budget -> paused + watermark still null. Mutation-verified the watermark rule.
- Page cursor (page_number/report_handle) left reserved — no paginated endpoint yet.
- ARCHITECTURE + STATUS updated. verify: 266 green.
