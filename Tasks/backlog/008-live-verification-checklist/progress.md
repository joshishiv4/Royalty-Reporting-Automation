# Progress: Live-verification checklist for behaviour only mocks can prove today

## Checklist

- [ ] Get UAT WL access confirmed working (health check passes against UAT)
- [ ] Walk the task.md checklist against UAT, row by row
- [ ] For each confirmed row: tick it, add date + observation
- [ ] For any contradiction: open a fix task and link it, leave the row unchecked
- [ ] Add rows as 004 and 006 land

## Last step

Not yet started. This is a standing ledger — it stays open by design.

## Blockers

None to start recording. Actually running the live checks needs working UAT WL
credentials (see docs/RUNBOOK.md).

## Log

### 2026-08-21
- Task created. Seeded from the four error-handling fixes (001, 002, 003, 005),
  all of which are unit-verified against a mocked `fetch` only. The rows capture
  the WL behaviours those mocks assume but no live call has confirmed.
- Rule for this task: when a later fix bakes in a WL assumption, add a row here in
  the same session rather than leaving the gap unrecorded.

### 2026-08-21 — dev env confirmed live
- healthcheck green: WL oauth2 token issued, Supabase REST reachable + service key
  accepted. sync:wellness fetched business + 1 location + 20 staff live. All 8
  control/data tables present in dev.
- This confirms the *link*, not the behavioural rows below — throttle, Retry-After,
  mid-pass token rotation, body reset still need their specific live conditions.

### 2026-08-21 — first live confirmations
- Verified against live UAT (dev env):
  - 200-for-errors + a_error[].sid: profile/purchase/list with no uid → HTTP 200,
    sid "uid-nx", classified permanent. The core envelope the whole client rests on.
  - k_log per endpoint: business/staff/location = null; /v1/lead/info = "[31.gswzy]".
    Exactly as trace.ts documents. Row ticked.
- Still unconfirmable without forcing the condition (a real throttle, a mid-stream
  reset, a mid-run token rotation, a long Retry-After): those rows stay unchecked.
  They need fault injection (a proxy) or catching a real throttle in production.

### 2026-08-21 — second round of live confirmations
- WlTokenClient classification confirmed live: a token request with a wrong secret
  (and a wrong id) returns HTTP 400 invalid_client; classifyStatus maps 400 -> auth
  (not retryable); real creds still issue a token. Row ticked. Also confirms the
  invalid_client-shaped refetch body that task 003's message assumes (mid-run 401
  half still pending a real rotation).
- Confirmed so far (4 rows): 200-for-errors + a_error[].sid; k_log per endpoint;
  token-error classification; and the invalid_client refetch shape (partial 003).
- Still blocked on forcing the condition, and honestly so:
    * throttle / Retry-After / long-Retry-After / sustained-throttle -> need WL to
      actually throttle us. WL publishes no limit and we have never hit one, so this
      cannot be summoned on demand; catch it in production instead.
    * body-read mid-stream reset -> needs a real socket cut. A faithful check means a
      local TLS server that accepts, writes a partial body, then destroys the socket,
      with the client's DATA host pointed at it (auth still real). Deferred: it is a
      real harness to stand up, not a quick probe.
    * per-request deadline under a slow call -> needs a slow/paused response, same
      fault-injection harness.
    * route returns no host -> exercise the deployed route with a wrong host.
    * "no rate limit" -> a question for WL Integrations, not a probe.
- 008 stays OPEN by design: it is a standing ledger, ticked as conditions arise.
