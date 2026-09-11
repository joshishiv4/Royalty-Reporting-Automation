# Progress: Bound the in-process retry ladder by attempts, not by delay source

## Checklist

- [x] Reproduce as a failing test: persistent throttle + `Retry-After`, assert call count is bounded
- [x] Add the attempt cap ahead of the `retryAfterMs ?? ladder` decision
- [x] Clamp a single WL-supplied sleep to the remaining budget
- [x] Confirm the three existing retry tests still pass
- [x] Mutation check: remove the cap, confirm red

## Last step

Not yet started.

## Blockers

None.

## Log

### 2026-08-21
- Task created from the WL sync error-handling review. Behaviour confirmed by a
  throwaway probe test (51 calls, 250s slept) rather than by reading alone.

### 2026-08-21 — done
- Implemented and mutation-verified (fix → green, mutation → clean red, restore).
- `npm run verify`: 218 tests across 18 files, green.
