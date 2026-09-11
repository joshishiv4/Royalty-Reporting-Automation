---
id: 004
title: Give a request a total deadline derived from the pass budget
status: done
priority: medium
depends_on: [001]
created: 2026-08-21
---

# Give a request a total deadline derived from the pass budget

## Goal

`timeoutMs` (default 30s) applies per attempt, and nothing caps the total time a
single `request()` may consume. Worst case for one step is
30 + 1 + 30 + 5 + 30 + 25 + 30 ≈ 151s, against a 50s step budget and a 60s Vercel
cap. The batch budget cannot help: it is checked before *starting* an item, never
against one in flight — correct by design, but it means the budget is not a bound
on wall-clock. The pass should report "ran out of time" rather than be killed by
the platform mid-request.

## Scope

- `src/wl/client.ts` — thread a deadline (absolute time) into `request()` and stop
  retrying once it passes, handing the item back for requeue.
- `src/wl/sync.ts` / `src/wl/batch.ts` — pass the remaining pass budget down so the
  deadline is derived, not a second hardcoded number.

## Out of scope

- The attempt cap itself — task 001 (this depends on it).
- Per-attempt `timeoutMs`, which is already correct.

## Acceptance criteria

- [ ] A step given a short remaining budget stops retrying and returns a failure
      with a non-null `requeueAfterMs` instead of running past the budget
- [ ] The sum of a single request's sleeps + attempts cannot exceed the budget
      handed to the pass
- [ ] No new hardcoded timeout — the bound comes from the existing budget
- [ ] Mutation-verified: removing the deadline check turns the suite red

## Constraints & notes

- Depends on task 001: the attempt cap and the deadline are the same loop, and
  building the deadline first would just be rebuilt when the cap lands.
- Keep the "never abandon a call already in flight" property — the deadline gates
  *starting* the next attempt, consistent with how `batch.ts` gates starting items.
