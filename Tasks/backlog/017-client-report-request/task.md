---
id: 017
title: P5.1 — request the client report and wait for it to finish
status: backlog
priority: high
depends_on: []
created: 2026-08-21
---

# P5.1 — request the client report and wait for it to finish

Maps to board item 5.1 (HRRAFEBAV-58). First link in the client-report chain
(5.1 -> 5.2 -> 5.3) that **unblocks the full client base** — WL has no client-list
endpoint, so the report is how we enumerate students, not just staff.

## Goal

Ask WL for the client report via `/v1/report/query`, and poll until it is ready,
capturing the report handle (and its expiry) needed to read it page by page (5.2).

## Open question — SPIKE THIS FIRST, before committing to the chain

**Does `/v1/report/query` actually produce the client base, and what is its
request/poll/handle shape?** Probe it live against UAT: which report id/params give
a client list, is it async (returns a handle to poll) or immediate, how is "ready"
signalled, does the handle expire. Record findings in `docs/WL-API-NOTES.md`. If the
report cannot enumerate clients, STOP and raise it — the whole chain depends on this.

## Scope

- A report-request helper: POST the report query, poll for completion, return the
  `report_handle` + `report_handle_expires_at`.
- Persist the handle in `sync_job_state` (columns already exist: `report_handle`,
  `report_handle_expires_at`, `state`), so 5.2 can resume a part-read report.
- Respect the pass budget: polling must not block past it — hand back and resume.

## Out of scope

- Reading the pages (5.2 / task 018) and saving clients (5.3 / task 019).
- Any non-client report.

## Acceptance criteria

- [ ] Live probe recorded in WL-API-NOTES: the report is confirmed to yield clients,
      with its request/poll/handle shape documented
- [ ] Requesting the report returns a handle; polling detects completion
- [ ] The handle + expiry are stored in `sync_job_state`
- [ ] Unit tests (mocked WL) for request + poll-until-ready + budget hand-back; a
      live proof against UAT

## Constraints & notes

- This is where the `sync_job_state` cursor fields finally get a consumer (task 016
  reserved them). Absolute times, not durations.
- If the handle expires, the report must be re-requested — `report_handle_expires_at`
  says whether resume is still possible.
