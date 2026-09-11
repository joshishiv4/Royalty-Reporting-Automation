---
id: 001
title: Bound the in-process retry ladder by attempts, not by delay source
status: done
priority: critical
depends_on: []
created: 2026-08-21
---

# Bound the in-process retry ladder by attempts, not by delay source

## Goal

`WlClient.request()` can retry forever. The ladder terminates only when
`throttleBackoffMs` returns null, but WL's own `Retry-After` short-circuits that
call, so a WL endpoint that keeps throttling produces an unbounded loop. On Vercel
the platform kills the function at 60s, which means a sustained WL throttle
produces a silent timeout with no summary, no `remaining` and no dead-letter
record — exactly the outcome the budget guard exists to prevent.

Measured 2026-08-21 with a mock returning `200 / status:"rate-limit"` +
`retry-after: 5` on every call: **51 data calls and 250s of sleeping**, stopped
only by a bailout in the test mock.

## Scope

- `src/wl/client.ts` — the retry loop at lines ~215-228.
- Cap total in-process attempts regardless of where the delay came from. The
  ladder length owns *how many*; WL owns only *how long*.
- Clamp a WL-supplied delay so one sleep cannot exceed what is left of the pass.
- Tests in `tests/wl-retry.test.ts`.

## Out of scope

- The requeue ladder's unused rungs — task 006.
- A total per-request deadline — task 004 (which builds on this).
- Changing what `parseRetryAfter` accepts — task 006.

## Acceptance criteria

- [ ] A fetch mock that returns a throttle with `Retry-After` on **every** call
      terminates, and the item comes back with a non-null `requeueAfterMs`
- [ ] Total data calls for that case is bounded by `THROTTLE_BACKOFF_MS.length + 1`,
      matching the no-`Retry-After` case already asserted at
      `tests/wl-retry.test.ts:117`
- [ ] The existing "prefers WL Retry-After over our own ladder" test still passes —
      WL's delay is still honoured while attempts remain
- [ ] Mutation-verified: removing the new cap turns the suite red

## Constraints & notes

- `sleep` and `random` are already injectable; the test must not wait real time.
- Do not silently swallow the failure. The point of the fix is that the pass
  *reports* a sustained throttle rather than being killed mid-flight.
