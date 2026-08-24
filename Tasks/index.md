# Task Index

Auto-maintained registry of all tasks. Reflects YAML frontmatter from each `task.md`.
Sorted by status (done last), then priority, then ID.

| ID  | Title | Status | Priority | Depends on | Path |
|-----|-------|--------|----------|------------|------|
| 008 | Live-verification checklist for behaviour only mocks can prove today | backlog | high | — | `backlog/008-live-verification-checklist/` |
| 017 | P5.1 — request the client report and wait for it to finish | backlog | high | — | `backlog/017-client-report-request/` |
| 018 | P5.2 — read the client report page by page | backlog | high | 017 | `backlog/018-client-report-paged-read/` |
| 019 | P5.3 — save clients into person without duplicates | backlog | high | 018 | `backlog/019-save-clients-dedup/` |
| 016 | sync_job_state — per-job progress and the clean-completion watermark | done | high | 012 | `done/016-sync-job-state-progress/` |
| 020 | P5.6 — pull service, category and location details | done | medium | — | `done/020-service-location-detail/` |
| 001 | Bound the in-process retry ladder by attempts, not by delay source | done | critical | — | `done/001-bound-retry-ladder-attempts/` |
| 004 | Give a request a total deadline derived from the pass budget | done | medium | 001 | `done/004-request-deadline-from-budget/` |
| 002 | Classify body-read failures as transient | done | high | — | `done/002-classify-body-read-failures/` |
| 003 | Handle WlAuthError inside the request retry loop | done | high | — | `done/003-handle-auth-error-in-request-loop/` |
| 007 | Apply the health-views/RLS migration to the live DB and run its isolation proof | done | high | — | `done/007-apply-and-prove-health-views-rls/` |
| 005 | Stop the sync route echoing raw error messages, and keep step errors | done | medium | — | `done/005-redact-route-error-messages/` |
| 006 | Settle and document what the retry ladders actually promise | done | medium | — | `done/006-settle-retry-ladder-promises/` |
| 013 | Supabase write client — PostgREST upsert/insert over fetch | done | high | — | `done/013-supabase-write-client/` |
| 010 | M03a — writer and raw_link (staff→person slice) | done | high | 013 | `done/010-m03a-writer-raw-link/` |
| 011 | M03b — the durable sync_queue claim, requeue and dead-letter loop | done | high | 010 | `done/011-m03b-queue-loop/` |
| 012 | M03c — resume cursor, sync_run accounting, and route wiring | done | high | 011 | `done/012-m03c-resume-and-route/` |
| 014 | M03a-purchases — purchase + purchase_item writer (money null) | done | high | 010 | `done/014-m03a-purchases-writer/` |
| 015 | Purchase receipt enrichment — money and the payment breakdown | done | high | 014 | `done/015-purchase-receipt-money/` |
| 021 | Purchase recipient — uid_recipient from the element endpoint | done | high | 014, 015 | `done/021-purchase-recipient/` |
| 022 | P6.1 — pull each client's profile details | done | high | 010 | `done/022-client-profile-enrichment/` |
| 023 | P6.2 — membership and refund detail on the purchase item | done | high | 014, 021 | `done/023-purchase-membership-detail/` |
| 009 | M03 sync engine — writer + durable queue (umbrella) | done | high | — | `done/009-m03-sync-engine-writer/` |
