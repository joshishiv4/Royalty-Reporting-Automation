---
id: 016
title: sync_job_state — per-job progress and the clean-completion watermark
status: done
priority: high
depends_on: [012]
created: 2026-08-21
---

# sync_job_state — per-job progress and the clean-completion watermark

Closes the "save progress after every page so a crash can resume" point (P4.3).

## Goal

Give every sync job a durable lifecycle row in `sync_job_state`, so an operator (and
a resume) can see whether a job is running, paused mid-budget, or last completed
cleanly — and record `last_clean_completion_at`, the watermark a future incremental
sync will trust.

## Scope

- A small module that opens and closes a `sync_job_state` row per pass, upserting on
  the PK `(job_name, k_business)`:
  - start → `state = 'running'`, `last_seen_at = now`
  - clean drain (pass `ok`) → `state = 'idle'`, `last_clean_completion_at = now`
  - budget hit (pass `partial`) → `state = 'paused'` — and DO NOT move the watermark
  - error (pass `failed`) → `state = 'failed'` — watermark untouched
- Wire it into `runPass` alongside the existing `sync_run` open/close.

## Out of scope — reserved until a paginated endpoint exists

- `page_number`, `last_key`, `report_handle`, `report_page`,
  `report_handle_expires_at`: the schema's cursor fields for a paged fetch
  (`/v1/report/data`). None of our endpoints paginate yet, so wiring them now would
  be a cursor with nothing to page. They stay at defaults/null; add when the
  paginated job lands.
- Using the watermark to make the sync incremental — that is a later optimisation;
  this task only RECORDS it correctly.

## Acceptance criteria

- [x] After a clean pass, the job's `sync_job_state` row is `idle` with
      `last_clean_completion_at` set to that run's finish
- [x] After a partial pass, the row is `paused` and `last_clean_completion_at` is
      UNCHANGED from before (a half-done run must not move the watermark)
- [x] After a failed pass, the row is `failed` and the watermark is unchanged
- [x] Re-running upserts the same row (PK job_name+k_business), never duplicates
- [x] Unit tests (fakes) for the three verdicts + a live proof against dev
- [x] ARCHITECTURE lists the new file; STATUS notes P4.3 done at the job level

## Constraints & notes

- The queue is already the crash-resume mechanism BETWEEN items; this adds the
  job-level record on top, and the watermark the schema documents.
- Upsert only the columns being set, so a future page cursor written elsewhere is
  not clobbered.
