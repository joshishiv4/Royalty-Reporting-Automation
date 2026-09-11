# Progress: Give a request a total deadline derived from the pass budget

## Checklist

- [x] Decide how the deadline is threaded (option on `WlRequestOptions` vs client field)
- [x] Derive it from the pass budget in `sync.ts` / `batch.ts`
- [x] Gate the next attempt on the deadline; requeue when it passes
- [x] Test: short budget stops retries early
- [x] Mutation check

## Last step

Not yet started.

## Blockers

Depends on task 001 (shared retry loop).

## Log

### 2026-08-21
- Task created from the WL sync error-handling review. Worst-case ~151s vs 60s cap.

### 2026-08-21
- Dependency 001 is done (retry loop now attempt-bounded). This task is unblocked;
  the deadline extends that same loop.

### 2026-08-21 — done
- Added `deadline` to WlRequestOptions; `canStartAfter` gates starting a retry so
  a single item cannot sleep past the pass budget. sync.ts derives it as
  `startedAt + budgetMs` (no new number) and threads it via runStep.
- In-flight calls are never abandoned — the gate only prevents starting more work,
  matching batch.ts.
- Mutation-verified (neuter canStartAfter → red). `npm run verify`: 220 tests green.
- Added a row to task 008 for the live check (a real slow WL call vs the deadline).
