---
id: 009
title: M03 sync engine — the writer and the durable queue loop
status: done
priority: high
depends_on: []
created: 2026-08-21
---

# M03 sync engine — the writer and the durable queue loop

> **GREEN-LIT 2026-08-21.** Scope and the open questions are settled (see
> "Decisions" below). Implementation is split into sub-tasks **010 → 011 → 012**;
> this task is the umbrella PRD. Coding still needs live access (tasks 007, 008).

## Goal

Nothing writes to the database yet. M02 built every table; M01 built the client,
retry, batch, trace and health. M03 is the missing middle: the code that reads WL,
stores the raw payload, parses it into the typed tables, and drives the durable
`sync_queue` so a run survives the process being killed at 60s. End state: a
scheduled invocation claims outstanding queue items, syncs the endpoints WL will
actually serve, records what it did in `sync_run`, and hands unfinished or failed
work back to `sync_queue` with the right `next_attempt_at` — resumable across
invocations with no data loss and no silent truncation.

**This is a PRD, not a green light to code.** It spans many files and has real open
questions (below). Confirm scope, settle the open questions, then split into
sub-tasks before writing the writer.

## Scope

The **reduced, buildable-now** slice — the endpoints that work today:

- **Writer core.** `src/wl/` (or a new `src/sync/`) module that, per work item:
  store the raw response in `raw_wl` (`source_endpoint` = path only, `k_business`,
  the record key/cursor), parse it into the typed tables, and record `raw_link`
  rows (`table_name`, `record_key`, `raw_wl_id`) so every typed row traces back to
  the payload it came from.
- **Endpoints in scope:** `/v1/staff/list` → `person` (the 14 with a teaching
  flag), `/v1/profile/purchase/list` + receipt detail → the purchase/payment/
  service rows (the royalty rows), `/v1/business` and `/v1/location/list` as
  context. ~1,780 calls for a full pass (STATUS reference numbers).
- **Durable queue loop.** Claim `sync_queue` items whose `next_attempt_at <= now()`
  under a lease (`claim_expires_at`), run them, and on the outcome:
  - success → `state = 'done'`;
  - transient/throttle → `state = 'pending'`, `next_attempt_at = now() +
    requeueAfterMs`, `attempt_count` advanced, `last_error*` columns from
    `WlErrorDetails`;
  - permanent or ladder spent (`requeueAfterMs === null`) → `state = 'dead'`;
  - a "needs a human" case → a `sync_conflict` row.
- **Run accounting.** One `sync_run` row per invocation, keyed by `client.runId`,
  ending in `ok` / `partial` / `failed`. `partial` (budget ran out — the normal
  way a run ends) is not a failure and must not read as one.
- **Resume.** `sync_job_state` cursor per job so a part-finished list/report picks
  up where it stopped, including `report_handle` for `/v1/report/data`.
- **Wire it to the route.** `api/wellness-sync.ts` runs one bounded slice per
  invocation instead of today's read-only pass; the 200-vs-503 verdict already
  distinguishes complete from partial.

## Out of scope

- **`attendance`** — `/v1/login/attendance/list` returns `date-incorrect`; the
  table stays empty until WL supplies the format (STATUS blocker 3).
- **Margin / `teacher_cost`** — WL returns pay-rate keys, never amounts;
  `enrollment_margin` stays null with `cost_is_known = false` (blocker 2).
- **The full client base** — no paged client-list endpoint exists, so `person`
  fills from staff only, not the wider ~47+ clients (blocker 1, the big one).
- **M04** — GoHighLevel matching and royalty calculation. No `src/ghl/` yet.
- **Raw-payload retention policy** — needed before the first full backfill, but a
  decision for someone, not code here (STATUS).
- Any new client-side infra: client, retry, batch, trace are done. If M03 finds a
  gap, that is a bug in those, not new scope here.

## Acceptance criteria

- [ ] A run reads the in-scope endpoints, writes `raw_wl` + parsed typed rows +
      `raw_link`, and every typed row joins back to its `raw_wl` payload
- [ ] Money is `numeric(12,2)` from WL's string; all WL keys stored as `text`; no
      host in any stored record or log (existing rules — proven, not assumed)
- [ ] A run killed mid-pass leaves `sync_queue` and `sync_job_state` such that the
      next invocation resumes with no duplicated and no dropped work
- [ ] A throttled/failed item lands back in `sync_queue` with `next_attempt_at =
      now() + requeueAfterMs` and the `last_error*` columns populated from
      `WlErrorDetails`; a spent item goes `dead`; a human-needed case opens a
      `sync_conflict`
- [ ] Each invocation writes exactly one `sync_run` keyed by `runId`, ending
      `ok` / `partial` / `failed`, with `partial` distinct from `failed`
- [ ] The `attempt_count` ↔ `priorAttempt` mapping (decision 4) has a test that
      fails if the first requeue lands on anything but the 1-minute rung
- [ ] Attendance, margin and the wider client base are left honestly null, not
      faked, and STATUS/DATA-MODEL say why
- [ ] Docs updated in the same commits (ARCHITECTURE file + flow, DATA-MODEL,
      STATUS + date) per CLAUDE.md; mutation-proven tests for the queue transitions

## Decisions (settled 2026-08-21)

1. **Scope:** the reduced slice above — staff + purchases + queue loop; attendance,
   margin, full client base deferred to their blockers.
2. **Queue granularity: one record per `sync_queue` row** (one `k_purchase`, one
   `uid`). Finest resume and dead-lettering; ~1,780 rows for a full pass is what the
   queue was built for.
3. **Concurrency: one worker per invocation.** The lease still guards overlap
   between invocations; `runBatch` already gives in-pass concurrency across items.
   Revisit only if one worker measurably can't keep up.
4. **`attempt_count` ↔ `priorAttempt`:** the writer passes `priorAttempt =
   attempt_count` (the value BEFORE this attempt) and increments `attempt_count` when
   it requeues. That walks 0→1min, 1→5min, 2→25min, 3→dead — the ladder the 0007 DDL
   documents. `attempt_count` therefore counts queue-level attempts (one per
   invocation), independent of the client's in-process throttle retries within a
   pass. **Pin with a test:** the first requeue must land on the 1-minute rung.
5. **Idempotent upserts:** upsert typed rows on their WL natural key (`uid`,
   `k_purchase`, purchase-item key). Confirm each table's actual unique constraint in
   the migrations during sub-task 010 before relying on it.
6. **Split:** 010 writer + raw_link (staff/purchases) → 011 queue claim/requeue/
   dead-letter loop → 012 resume/cursor + route wiring. 009 stays the umbrella.

## Constraints & notes

- **Survive the process dying.** A Vercel function is capped at 60s; the daily sync
  is budgeted at ~2h. The run WILL be cut off mid-way as routine. Everything to
  carry on lives in the database, not memory — absolute `next_attempt_at`, not
  durations.
- The client contract is ready and matches the schema: `WlErrorDetails` mirrors the
  `sync_queue.last_error*` columns, `requeueAfterMs` → `next_attempt_at`,
  `requeueAfterMs === null` → dead-letter, `runId` → `sync_run.run_id`,
  budget-exhausted → `partial`.
- **Needs live access to build against:** a real Supabase (task 007's blocker — the
  org access) and confirmed UAT WL (task 008). Add a row to task 008 for any WL
  behaviour the writer's tests mock.
- Read [docs/DATA-MODEL.md](../../../docs/DATA-MODEL.md) before adding or touching a
  table: one human is one `person`, the purchase **item** is the royalty row,
  `text_login_type` never identifies a teacher — measured decisions, not defaults.

## Resources

- `resources/` — empty. Add WL sample payloads (staff, purchase list, receipt) here
  when captured from UAT, so the parser has fixtures to test against.
