---
id: 024
title: P6.3 — keep the original response, and measure what it costs
status: done
priority: medium
depends_on: [010, 015, 022, 023]
created: 2026-08-24
---

# P6.3 — keep the original response, and measure what it costs

Board item 6.3. Several purchase fields are still not fully understood, and at
least one open question will change how they are read. Keeping the original
response next to the typed columns means those decisions can be revisited without
re-pulling every client from a rate-limited API.

## Context

The storage itself is not new work — `raw_wl` (migration `0008`) and `raw_link`
(`0009`) landed with the writer in tasks 009/010, and every writer since has fed
them. What 6.3 actually asks for that was never done is the **measurement**: how
fast does this grow per client, and is that a cost worth paying.

Unmeasured, "keep everything forever" is not a decision, it is an absence of one.

## Goal

Confirm the three storage criteria against live data, measure storage growth per
client, and record the number where the retention decision will be made.

## Scope

- Verify coverage, provenance and traceability against live dev data.
- Measure average payload size per endpoint and derive per-client growth.
- Record the measurement in DATA-MODEL next to `raw_wl`, and the retention
  question in STATUS as an open question.

## Out of scope

- Actually deciding the retention window — that is a business call, and this
  task exists to inform it.
- Building a re-process path over stored payloads (see below). Its own task.

## Acceptance criteria

- [x] Original response stored for every profile, purchase, item and receipt call
- [x] Each raw record notes its endpoint, target record and fetch time
- [x] Any typed row can be traced back to the response it came from
- [x] Storage growth per client measured and noted

## What the measurement says

| Call | Average payload |
|---|---|
| `/v1/user` (profile) | 2.4 KB |
| `/v1/profile/purchase/list` | 3.2 KB |
| `/v1/profile/purchase/list/element` | 2.2 KB |
| `/v1/purchase/receipt` | **7.7 KB** |

**~58 KB per client per full sync** at dev's shape (5.5 items and 5.5 purchases
per client). At 1,000 clients: 57 MB per pass, ~20.3 GB for a year of daily
syncs. Receipts are 42 KB of the 58 — the largest response, one per purchase.

## The gap this measurement exposed

6.3's own justification is "revisit decisions without re-pulling every client".
**We can store, but we cannot re-read.**

Proven the hard way on 24 Aug 2026: 73 receipts were fetched and stored on
21 Aug, before the money writer (task 015) existed. Those payloads sat in
`raw_wl`, complete, `status: ok`, with their `a_price` block intact. Filling in
the money should have been a re-parse costing zero API calls. Instead all 73 were
re-fetched from WL, because nothing can re-process a stored payload.

`raw_wl.processed_at`, `processed_by_run_id`, `process_error` and
`parser_version` exist for exactly this and are unused. Recorded as an open
question in STATUS; worth its own task.
