# Progress: Handle WlAuthError inside the request retry loop

## Checklist

- [x] Failing test: token succeeds once, then 401s on refresh mid-pass
- [x] Handle `WlAuthError` in the loop; map by `kind`
- [x] Second test: transient token failure recovers on retry
- [x] Verify `runStep` needs no change once the client handles it
- [x] Mutation check: revert, confirm red

## Last step

Not yet started.

## Blockers

None.

## Log

### 2026-08-21
- Task created from the WL sync error-handling review. Probe confirmed the exact
  message that is currently discarded.

### 2026-08-21 — done
- Implemented and mutation-verified (fix → green, mutation → clean red, restore).
- `npm run verify`: 218 tests across 18 files, green.
