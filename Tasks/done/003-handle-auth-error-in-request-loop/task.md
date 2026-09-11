---
id: 003
title: Handle WlAuthError inside the request retry loop
status: done
priority: high
depends_on: []
created: 2026-08-21
---

# Handle WlAuthError inside the request retry loop

## Goal

`attempt()` calls `tokens.getAccessToken()`, which throws `WlAuthError`.
`request()` rethrows it unclassified, and `runStep` only handles
`WlRequestError` — so the step reports `'failed for an unknown reason'` and the
actionable message is discarded.

Confirmed 2026-08-21, message lost:
`credentials rejected with HTTP 401 (invalid_client) - check WL_CLIENT_ID and
WL_CLIENT_SECRET for that environment`.

This is not a corner case. It is the normal path after a 401: `invalidate()` →
`continue` → refetch → if the credentials rotated under a running pass,
`WlAuthError`. So the most likely auth failure in a long pass produces the least
informative output, and `ensureAuthenticated()` up front cannot catch it — the
token was valid at minute zero and rotated at minute forty. A transient token
failure (a network blip during refresh) carries retry intent in
`WlAuthError.kind` that nothing currently reads.

## Scope

- `src/wl/client.ts` — the catch in `request()` (line ~200) and/or `attempt()`.
- `kind: 'transient'` joins the existing backoff ladder.
- `kind: 'auth'` / `'permanent'` become a `WlRequestError` that preserves the
  original message, the trace id, and the `cause`.
- Tests: mid-pass token rotation, and a transient token failure that recovers.

## Out of scope

- Changing `WlTokenClient` itself — its classification is already correct.
- `runStep` in `sync.ts` — if this is fixed in the client, no change is needed
  there. Confirm that rather than assuming it.

## Acceptance criteria

- [ ] A pass whose credentials fail on a mid-run refresh reports the credential
      message, not `'failed for an unknown reason'`
- [ ] The step carries a real `traceId`, not `'unknown'`
- [ ] A transient token failure is retried on the ladder and the pass can still
      succeed
- [ ] An `auth`-kind token failure is not retried indefinitely and carries
      `requeueAfterMs: null`
- [ ] Mutation-verified: reverting the handler turns the suite red

## Constraints & notes

- `WlAuthError` messages are already host-safe and env-named. Preserve the text
  verbatim rather than rewriting it — that message is the whole value of the fix.
- The existing one-shot 401 retry (`authRetried`) must keep working; this adds the
  case where the *refetch itself* fails.
