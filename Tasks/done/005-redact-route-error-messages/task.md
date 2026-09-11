---
id: 005
title: Stop the sync route echoing raw error messages, and keep step errors
status: done
priority: medium
depends_on: []
created: 2026-08-21
---

# Stop the sync route echoing raw error messages, and keep step errors

## Goal

`api/wellness-sync.ts` catches every throw as `'configuration could not be
resolved'` and echoes `error.message` verbatim. Two problems: it sends the
operator to the wrong file for any non-config failure, and it can leak a host into
an HTTP response body. `client.ts` and `token.ts` deliberately report only
`cause.name` because "the message can carry the host, which is configuration" — an
error escaping through the route's catch-all defeats that, and
`tests/no-hardcoded-config.test.ts` cannot catch it because it scans source, not
runtime strings.

Bundled: `unexpectedStepFailure` in `sync.ts` discards `f.error`, so the one place
a genuine bug in `runStep` would surface reports nothing about it.

## Scope

- `api/wellness-sync.ts` — distinguish config-resolution failures from everything
  else; redact unknown errors to a host-safe form before returning them.
- `src/wl/sync.ts` — carry a redacted detail from `f.error` into the failed step
  instead of dropping it.

## Out of scope

- Config validation messages themselves — they already name keys, not values, and
  are safe to return.

## Acceptance criteria

- [ ] A non-config error thrown from the sync path is not labelled a configuration
      error
- [ ] No error returned by the route contains a host — verified with an injected
      error whose message embeds one
- [ ] `unexpectedStepFailure` records a redacted detail derived from the actual
      error rather than a fixed string
- [ ] Mutation-verified: an error carrying a host reaches the response body if the
      redaction is removed, and the test catches it

## Constraints & notes

- Reuse the naming approach in `describeFetchFailure` rather than inventing a
  second redactor.
- This is the trust boundary the CLAUDE.md host rule is about — do not simplify
  the redaction away.
