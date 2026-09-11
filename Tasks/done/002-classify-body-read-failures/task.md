---
id: 002
title: Classify body-read failures as transient
status: done
priority: high
depends_on: []
created: 2026-08-21
---

# Classify body-read failures as transient

## Goal

`response.text()` in `WlClient.attempt()` sits outside the try/catch that guards
`doFetch`, so a connection reset mid-body — or the abort signal firing during body
streaming — throws a raw `Error` that escapes the failure taxonomy entirely.
Confirmed 2026-08-21: `kind: undefined`, not a `WlRequestError`.

It then escapes `request()` (which rethrows anything that is not a
`WlRequestError`) and lands in `runStep`'s generic catch, reporting
`'failed for an unknown reason'`, `traceId: 'unknown'` and `latencyMs: 0`. So the
one network failure that happens *after* a successful connect gets no
classification, no retry, no trace id and no latency — despite being textbook
transient. `client.ts` argues in its own comments that reporting `latencyMs: 0`
throws away the number that identifies the failure; this path does exactly that.

## Scope

- `src/wl/client.ts` — `attempt()`, around line 302.
- Bring the body read inside the guarded region (or its own guard) so it produces
  the same transient `WlRequestError` as a connect failure, with the real
  `traceId` and `latencyMs`.
- Tests: a fetch mock whose `text()` rejects.

## Out of scope

- `WlAuthError` handling in the loop — task 003.
- The `unexpectedStepFailure` swallowed error in `sync.ts` — task 005.

## Acceptance criteria

- [ ] A response whose `text()` rejects produces a `WlRequestError` with
      `kind: 'transient'`
- [ ] That error carries the call's real `traceId` and a non-zero `latencyMs`
- [ ] It is retried on the backoff ladder like any other transient failure
- [ ] The error message names only the error class, never the host — matching
      `describeFetchFailure`
- [ ] Mutation-verified: moving the read back outside the guard turns the suite red

## Constraints & notes

- `describeFetchFailure` already exists and already does the host-safe naming.
  Reuse it rather than writing a second message builder.
- An `AbortError` raised during body streaming should read as a timeout, same as
  one raised during connect.
