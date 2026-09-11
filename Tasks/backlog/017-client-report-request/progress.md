# Progress: P5.1 — request the client report and wait for it to finish

## Checklist

- [ ] Probe /v1/report/query live: confirm it yields clients + its shape
- [ ] Request helper + poll-until-ready
- [ ] Persist report_handle in sync_job_state
- [ ] Unit tests + live proof

## Last step

Not yet started.

## Blockers

Dev/UAT is live. First real gate: the open question in task.md (probe the endpoint
shape) — the client-report chain depends on the report actually yielding clients.

## Log

### 2026-08-21
- Created from the P5 board audit. This is a pending P5 item mapped to local tracking.

### 2026-08-21 — spike started, blocked on the report CID
- Probed /v1/report/query live: it is POST (GET -> method-nx) and requires a
  cid_report (positive integer) naming which report. Empty/guessed CIDs
  (1/10/100/439) return cid-nx ("does not exist"), so CIDs are specific and
  not guessable.
- BLOCKER: we need the client report's cid_report from WL (its admin UI export
  URL / report config typically shows it). Without it the async-vs-paged shape
  cannot be probed and 017/018 cannot be finalised.
- Recorded in docs/WL-API-NOTES.md open question #1.
