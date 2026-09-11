---
id: 006
title: Settle and document what the retry ladders actually promise
status: done
priority: medium
depends_on: []
created: 2026-08-21
---

# Settle and document what the retry ladders actually promise

## Goal

Two places where `retry.ts` documents behaviour the running code does not deliver.
Both are decisions, not bugs, and the doc is currently the misleading part.

1. **Requeue ladder unused.** The only production caller of `retryDelayMs`
   (`client.ts` line ~228) always passes attempt `0`, so `requeueAfterMs` is
   always ~60s and the 5- and 25-minute rungs are unreachable. `retry.ts`
   documents a 1/5/25 requeue schedule as implemented. The attempt count that
   would walk the ladder belongs to the queue layer, which does not exist until
   M03.

2. **Long `Retry-After` discarded.** `parseRetryAfter` returns null for anything
   over 60s, so `Retry-After: 300` falls through to the ladder and retries in ~1s
   — hammering a server that explicitly asked for five minutes. The intent (do not
   stall the run) is right; the mechanism should hand the item back for requeue
   with that delay, not ignore it.

## Scope

- Decide, with whoever owns M03, what each ladder promises.
- Make `src/wl/retry.ts` and its comments say what the code does — either by
  changing the code, or by marking the gap with a `ponytail:` note naming the
  M03 dependency.
- If the `Retry-After` behaviour changes, update `tests/wl-retry.test.ts`, which
  currently asserts the discard as desired.

## Out of scope

- Building the queue/worker layer — that is M03.
- The unbounded-loop fix — task 001.

## Acceptance criteria

- [ ] `retry.ts` no longer documents a schedule the running code cannot produce;
      any deferral is marked with the reason and the unblocking milestone
- [ ] A decision is recorded (here and in `docs/`) for the long-`Retry-After`
      case: honour-via-requeue or keep-ignoring, with the why
- [ ] If behaviour changed, tests assert the new behaviour and a mutation turns
      them red; if only docs changed, say so explicitly

## Constraints & notes

- This is partly a documentation-truth task, which CLAUDE.md treats as
  load-bearing: a drifted doc here is worse than none.
- Likely lands with M03 rather than before it. Kept separate so the code half is
  not blocked on the doc decision.
