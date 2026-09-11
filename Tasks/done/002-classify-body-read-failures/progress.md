# Progress: Classify body-read failures as transient

## Checklist

- [x] Failing test: fetch mock with a rejecting `text()`
- [x] Move the body read inside the guard, reusing `describeFetchFailure`
- [x] Assert kind, traceId and non-zero latencyMs
- [x] Mutation check: revert the guard, confirm red

## Last step

Not yet started.

## Blockers

None.

## Log

### 2026-08-21
- Task created from the WL sync error-handling review. Confirmed by probe:
  the thrown value is a plain `Error` with `kind: undefined`.

### 2026-08-21 — done
- Implemented and mutation-verified (fix → green, mutation → clean red, restore).
- `npm run verify`: 218 tests across 18 files, green.
