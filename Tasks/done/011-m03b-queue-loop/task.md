---
id: 011
title: M03b — the durable sync_queue claim, requeue and dead-letter loop
status: done
priority: high
depends_on: [010]
created: 2026-08-21
---

# M03b — the durable sync_queue claim, requeue and dead-letter loop

Sub-task of [009](../009-m03-sync-engine-writer/task.md). Wraps the 010 writer in
the durable queue so a run survives the process dying.

## Goal

Drive work from `sync_queue` so nothing is lost across the 60s function cap. Claim
eligible items under a lease, run them through the 010 writer, and translate the
client's outcome into the right queue state and `next_attempt_at`.

## Scope

- Claim items where `next_attempt_at <= now()` and no live lease, set
  `state = 'in_progress'` with `claim_expires_at` (a lease past the step budget).
  One worker per invocation (decision 3 in 009).
- On outcome:
  - success → `state = 'done'`;
  - transient/throttle → `state = 'pending'`, `next_attempt_at = now() +
    requeueAfterMs`, `last_error*` from `WlErrorDetails`, then `attempt_count += 1`;
  - permanent or `requeueAfterMs === null` → `state = 'dead'`;
  - human-needed → a `sync_conflict` row.
- Pass `priorAttempt = attempt_count` (pre-increment) into `client.request` so the
  requeue rung widens 1 → 5 → 25 min then dead (decision 4 in 009).
- Reclaim: an `in_progress` item past `claim_expires_at` is eligible again.

## Out of scope

- Parsing/writing typed rows — that's 010, called by this loop.
- Cursor/resume for part-finished lists and the route — task 012.

## Acceptance criteria

- [x] A claimed item that succeeds goes `done`; a throttled one returns to
      `pending` with `next_attempt_at = now() + requeueAfterMs` and populated
      `last_error*`
- [x] The first requeue lands on the 1-minute rung; the fourth attempt dead-letters
      (`state = 'dead'`) — the attempt_count↔priorAttempt test from decision 4
- [x] An item whose lease expired mid-flight is re-claimable, not stranded
- [x] A permanent error dead-letters without retrying; a human-needed case opens a
      `sync_conflict`
- [x] Queue-transition tests are mutation-proven (break a transition → red)

## Constraints & notes

- Absolute `next_attempt_at`, never a duration — it must survive a crash/redeploy.
- The client contract already matches the columns (`WlErrorDetails` ↔ `last_error*`,
  `requeueAfterMs` ↔ `next_attempt_at`, null ↔ dead). No client changes expected; a
  gap there is a bug in the client, not new scope.
- Update DATA-MODEL/ARCHITECTURE in the same commit if the loop adds a file.
