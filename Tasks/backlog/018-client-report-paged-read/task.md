---
id: 018
title: P5.2 — read the client report page by page
status: backlog
priority: high
depends_on: [017]
created: 2026-08-21
---

# P5.2 — read the client report page by page

Board item 5.2 (HRRAFEBAV-59). Reads the report 017 requested, one page at a time,
saving progress so a crash resumes mid-report.

## Goal

Walk the client report via `/v1/report/data` using the stored report handle, page by
page, advancing `sync_job_state.report_page` after each page so a budget cut or crash
resumes at the next unread page — not from the top.

## Scope

- Fetch a page with the handle + current page number; parse the client rows out.
- After each page, update `sync_job_state.report_page` (+ `last_seen_at`); hand parsed
  rows to the 5.3 dedup-save (task 019).
- Budget-aware: stop STARTING a new page past the budget, resume next invocation.

## Out of scope

- Requesting the report (017) and the person upsert itself (019).

## Acceptance criteria

- [ ] Reads all pages of a report using the handle; parses client rows per page
- [ ] `report_page` advances after each saved page; a re-run resumes at the next
      unread page with no page re-read and none skipped
- [ ] A budget cut mid-report leaves a resumable cursor (paused), watermark unmoved
- [ ] Unit tests (mocked pages) for paging + resume; a live proof against UAT

## Constraints & notes

- The page cursor is the whole point of `sync_job_state` — task 016's reserved fields
  finally put to work.
- WL list pages are KEYED OBJECTS, not arrays (CLAUDE.md) — iterate Object.values.
