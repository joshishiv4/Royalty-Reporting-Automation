# Progress: Stop the sync route echoing raw error messages, and keep step errors

## Checklist

- [x] Test: inject an error whose message embeds a host, assert it never reaches the body
- [x] Split config-resolution failures from the rest in the route catch
- [x] Redact unknown errors to name-only
- [x] Carry a redacted detail through `unexpectedStepFailure`
- [x] Mutation check

## Last step

Not yet started.

## Blockers

None.

## Log

### 2026-08-21
- Task created from the WL sync error-handling review (findings 7 and 8d).

### 2026-08-21 — done
- Implemented and mutation-verified (fix → green, mutation → clean red, restore).
- `npm run verify`: 218 tests across 18 files, green.
