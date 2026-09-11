# Progress: Settle and document what the retry ladders actually promise

## Checklist

- [x] Confirm with M03 owner what the requeue ladder and long-Retry-After should do
- [x] Either implement, or mark the gap with a `ponytail:` note + milestone
- [x] Record the long-Retry-After decision in docs/
- [x] Update tests if behaviour changed

## Last step

Not yet started.

## Blockers

Needs a decision from whoever owns the M03 queue layer before the code half can land.

## Log

### 2026-08-21
- Task created from the WL sync error-handling review (findings 4 and 8a).

### 2026-08-21 — decisions + done
- Decisions (from M03 owner): (1) long Retry-After → requeue with WL's delay;
  (2) thread attempt count now; (3) M03 owned by this team, soon.
- Implemented: parseRetryAfter ceiling 60s→1h so long delays survive to requeue;
  MAX_IN_PROCESS_RETRY_AFTER_MS (25s) splits sleep-in-process from requeue;
  WlRequestOptions.priorAttempt selects the requeue rung (dead-letters when spent).
- WL Retry-After outranks the ladder both ways: sleeps in-process if short, else
  requeues with that exact delay.
- Docs updated same commit: retry.ts inline, ARCHITECTURE flow, STATUS row + date.
- Mutation-verified both new behaviours. npm run verify: 222 tests green.
