# Architecture

Where everything lives, and why it is arranged this way. For "how do I run it" see
[README.md](../README.md); for the tables see [DATA-MODEL.md](DATA-MODEL.md); for
what is built and what is not see [STATUS.md](STATUS.md).

## The shape of the thing

```
WellnessLiving ──┐
                 ├──> sync service ──> Supabase ──> royalty reports
GoHighLevel ─────┘                        │
                                          └──> student portal (later)
```

One nightly pass reads WellnessLiving, matches people against GoHighLevel, and
lands everything in Supabase. Reports and a portal read from there. The service
never writes back to either API.

## Module map

```
src/
  config/        resolving and validating configuration
  secrets/       where credentials come from
  wl/            the WellnessLiving client
  supabase/      Supabase health probe
  logging/       structured logging and redaction
  http/          shared HTTP-route concerns
  health/        dependency probes
  cli/           the command-line entry point
api/             Vercel serverless routes
supabase/
  migrations/    schema, applied in numeric order
  checks/        read-only verification scripts
tests/           one file per concern, mirroring src/
```

## Where things are defined

### Configuration

| Question | File |
|---|---|
| What settings exist, and their types | [`src/config/schema.ts`](../src/config/schema.ts) |
| How they are resolved and frozen | [`src/config/index.ts`](../src/config/index.ts) |
| The one shape every provider uses | [`src/secrets/settings-shape.ts`](../src/secrets/settings-shape.ts) |
| Reading from `.env` | [`src/secrets/env-provider.ts`](../src/secrets/env-provider.ts) |
| Reading from `config/settings.<env>.json` | [`src/secrets/file-provider.ts`](../src/secrets/file-provider.ts) |
| Reading from AWS Secrets Manager | [`src/secrets/aws-secrets-manager-provider.ts`](../src/secrets/aws-secrets-manager-provider.ts) |

**One shape, three providers.** `APP_ENV` selects a whole bundle, so the WL host,
region and business id always move together — a config can never be half dev and
half prod. `SECRETS_PROVIDER` selects where that bundle is read from.

**It fails closed.** `loadConfig()` validates with Zod and throws before the first
API call, naming every missing or placeholder key. A run that cannot be configured
correctly does not start.

### WellnessLiving

| Question | File |
|---|---|
| Getting and caching a token | [`src/wl/token.ts`](../src/wl/token.ts) |
| Every data call, and the success check | [`src/wl/client.ts`](../src/wl/client.ts) |
| URL building and the endpoint list | [`src/wl/endpoint.ts`](../src/wl/endpoint.ts) |
| Backoff and requeue timing | [`src/wl/retry.ts`](../src/wl/retry.ts) |
| Running many calls inside a time budget | [`src/wl/batch.ts`](../src/wl/batch.ts) |
| Trace ids | [`src/wl/trace.ts`](../src/wl/trace.ts) |
| One sync pass | [`src/wl/sync.ts`](../src/wl/sync.ts) |
| Auth reachability probe | [`src/wl/health.ts`](../src/wl/health.ts) |
| The client-list report: single-shot request / poll / read (non-blocking — the pass polls across queue invocations, not in a sleep loop), the mandatory date window, paging | [`src/wl/report.ts`](../src/wl/report.ts) |
| Client-list rows → person (mapped by field NAME, never position) | [`src/sync/clients.ts`](../src/sync/clients.ts) |
| Writing WL responses to Supabase (raw_wl → typed rows → raw_link) | [`src/sync/writer.ts`](../src/sync/writer.ts) |
| Writing GHL responses to Supabase (raw_ghl), and the recorder that makes every search store itself | [`src/sync/ghl-writer.ts`](../src/sync/ghl-writer.ts) |
| Writing purchases (list → purchase + purchase_item, stub FKs) | [`src/sync/purchases.ts`](../src/sync/purchases.ts) |
| Enriching purchases with money (receipt → totals, payments, credit) | [`src/sync/receipts.ts`](../src/sync/receipts.ts) |
| Enriching purchases with the recipient (purchase/list/element → uid_recipient, person stub, conflict on disagreement) | [`src/sync/recipients.ts`](../src/sync/recipients.ts) |
| Membership state and refund on the purchase item (purchase/list/element → hold, cancellation, renewal, refund) | [`src/sync/memberships.ts`](../src/sync/memberships.ts) |
| Enriching people with their profile (user → primary email, phones, DOB; merge, never clobber) | [`src/sync/profiles.ts`](../src/sync/profiles.ts) |
| Location detail (location/list → title, timezone) | [`src/sync/locations.ts`](../src/sync/locations.ts) |
| Promotions (classes/promotion → promotion, per-location) | [`src/sync/promotions.ts`](../src/sync/promotions.ts) |
| Shop categories (shop/category → shop_category, business-wide) | [`src/sync/shop-categories.ts`](../src/sync/shop-categories.ts) |
| Login types (login/type → login_type; `is_teacher_type` defines the `teacher` view) | [`src/sync/login-types.ts`](../src/sync/login-types.ts) |
| Linking a person to their GoHighLevel contact (phone first, email second, names never) | [`src/ghl/matcher.ts`](../src/ghl/matcher.ts) |
| The class schedule (schedule/class/list → session + session_staff, keyed on class **and** date) | [`src/sync/sessions.ts`](../src/sync/sessions.ts) |
| Who booked and who turned up (login/attendance/list → attendance, per occurrence) | [`src/sync/attendance.ts`](../src/sync/attendance.ts) |
| Private appointments, per client (schedule/page/list + element → session, staff, attendance) | [`src/sync/client-sessions.ts`](../src/sync/client-sessions.ts) |
| **How far back each visit sync reaches** — `is_past` + `dtu_start`/`dtu_end`, initial vs daily, decided by the clean-completion watermark | [`src/sync/visit-window.ts`](../src/sync/visit-window.ts) |
| **What WL's visit status means** — `WlVisitSid` → the `attendance` outcome columns, in ONE place because two passes write them | [`src/sync/visit-outcome.ts`](../src/sync/visit-outcome.ts) |
| Service catalogue + categories (appointment/book/service/{list,category} → service, service_category; marks is_resolved) | [`src/sync/services.ts`](../src/sync/services.ts) |
| The durable sync_queue loop (claim, settle, requeue, dead-letter; claims and processes the batch as a bounded concurrent pool; `outcomeFromError` requeues a transient DB error instead of failing the pass) | [`src/sync/queue.ts`](../src/sync/queue.ts) |
| One bounded sync pass per job, `runFullSyncPass` (sequential FK order, one token, one budget), and `runFullSyncPassParallel` (three dependency waves, seed-once-per-pass, one shared token — the local backfill shape) | [`src/sync/pass.ts`](../src/sync/pass.ts) |
| Per-job lifecycle + clean-completion watermark, and the async-report cursor (handle/poll-attempt/deadline) the client-list poller resumes from (sync_job_state) | [`src/sync/job-state.ts`](../src/sync/job-state.ts) |

Four things about this client are worth knowing before changing it:

**Success is read from the body, never the status code.** WL answers HTTP 200 for
errors. `WlClient.attempt()` asserts `status === "ok"` before returning anything,
and this is enforced in one place so no job can skip it — there is a structural
test in [`tests/wl-error-200.test.ts`](../tests/wl-error-200.test.ts) that fails if
any module outside the client calls `fetch` itself.

**Failures are classified, not just counted.** `auth` invalidates the token and
retries once. `permanent` (a bad parameter) fails on the first call. `transient`
(throttle, timeout) backs off. See [`src/wl/client.ts`](../src/wl/client.ts) for
the `sid` patterns.

**There is no client-side rate limit, deliberately.** WL publishes none, and
measurement found none. What remains is reaction: a widening jittered backoff and
a requeue schedule. `WL_MAX_CONCURRENCY` bounds items in flight, which is not a
request rate.

**Every call carries our own trace id.** `runId.seq`, so one grep of a `runId`
returns a whole pass in order. WL's `k_log` is captured where it exists, which is
not most endpoints — see [WL-API-NOTES.md](WL-API-NOTES.md).

### GoHighLevel

| Question | File |
|---|---|
| Every contact-search call, retries, HTTP-status classification | [`src/ghl/client.ts`](../src/ghl/client.ts) |
| URL building and the endpoint list | [`src/ghl/endpoint.ts`](../src/ghl/endpoint.ts) |
| Backoff timing (mirrors WL's shape) | [`src/ghl/retry.ts`](../src/ghl/retry.ts) |
| Auth reachability probe | [`src/ghl/health.ts`](../src/ghl/health.ts) |
| Projecting a fetched contact into the fields and tags `ghl_contact` stores — pure, reaches nothing | [`src/ghl/snapshot.ts`](../src/ghl/snapshot.ts) |

Three things about this client are worth knowing before changing it:

**It is read-only by construction, not by convention.** The public surface is
exactly `searchContacts`. There is no generic `request()` method a future caller
could point at a mutating path, and `GHL_PATHS` lists one path — a write path
cannot be added by accident.

**No OAuth dance.** GoHighLevel Private Integration Tokens (`pit-...`) are
long-lived bearer tokens; there is no refresh flow, no cache to share and no
single-flight to arrange. The token is sent verbatim on every call.

**Success is the HTTP status.** Unlike WellnessLiving, GHL uses HTTP status
honestly — 200 is ok, 4xx/5xx mean what they say. There is no "200 with an error
envelope inside" trap to guard against.

### Entry points

| Question | File |
|---|---|
| CLI commands — `healthcheck`, `sync:wellness`, `sync:full-parallel`, `config:check`, `config:show` | [`src/cli/main.ts`](../src/cli/main.ts) |
| Everything the package exports | [`src/index.ts`](../src/index.ts) |
| Vercel health route | [`api/health.ts`](../api/health.ts) |
| Vercel sync route — staff only, targeted | [`api/wellness-sync.ts`](../api/wellness-sync.ts) |
| Vercel FULL sync route — every pass, the daily cron | [`api/wellness-sync-all.ts`](../api/wellness-sync-all.ts) |
| Reading and setting the visit sync's date window — GET what the next window will be and why, POST a ONE-SHOT manual `{start,end}`, DELETE to clear | [`api/sync-window.ts`](../api/sync-window.ts) |

The CLI and the routes are thin: both resolve config, build a client, and call the
same functions. Nothing lives only in an entry point.

### Health, HTTP and shared types

| Question | File |
|---|---|
| Running every dependency probe | [`src/health/index.ts`](../src/health/index.ts) |
| The probe result shape | [`src/health/types.ts`](../src/health/types.ts) |
| Supabase reachability and key acceptance | [`src/supabase/health.ts`](../src/supabase/health.ts) |
| Supabase writes/reads (PostgREST over fetch) | [`src/supabase/client.ts`](../src/supabase/client.ts) |
| Constant-time bearer check for routes | [`src/http/bearer.ts`](../src/http/bearer.ts) |
| Route request/response shapes | [`src/http/types.ts`](../src/http/types.ts) |
| Provider selection | [`src/secrets/index.ts`](../src/secrets/index.ts) |
| Secret bundle and env types | [`src/secrets/types.ts`](../src/secrets/types.ts) |

`isAuthorized()` returns false when no token is configured — an unset secret must
LOCK a route, never open it.

### Logging

| Question | File |
|---|---|
| The logger, levels, fan-out | [`src/logging/logger.ts`](../src/logging/logger.ts) |
| Credential scrubbing and fingerprinting | [`src/logging/redact.ts`](../src/logging/redact.ts) |
| Log files and rotation | [`src/logging/file-sink.ts`](../src/logging/file-sink.ts) |

**Redaction happens once, before fan-out.** Sinks receive a finished string, never
fields they could format themselves. That ordering is the guarantee: a transport
cannot reintroduce a secret the console never showed. A log file is the one place
a leak outlives the process.

File logging is opt-in (`LOG_TO_FILE`) because on Vercel the filesystem is
read-only apart from an ephemeral `/tmp`.

### Database

Migrations are numbered and applied in order. Each one is self-contained and safe
to re-run.

| Migration | Contents |
|---|---|
| `0000` | Reset helper for the superseded first draft |
| `0001` | `person`, `lead`, `client`/`teacher` views |
| `0002` | `location`, `service`, `purchase`, `purchase_item`, `purchase_payment`, `purchase_account_credit` |
| `0003` | View security fix |
| `0004` | `session`, `session_staff`, `attendance` |
| `0005`–`0006` | `created_at`/`updated_at`/`synced_at` and the trigger, everywhere |
| `0007` | `sync_queue`, `sync_job_state`, `sync_run`, `sync_conflict` |
| `0008` | `raw_wl`, `raw_ghl` |
| `0009` | `raw_link` |
| `0010` | Health views, supporting views, RLS policies |
| `0011` | `promotion`, `shop_category` (reference lookups) |
| `0012` | `service_category`; `service` enrichment + `is_resolved`; `unresolved_service` view |
| `0013` | `purchase_item` membership state (`sid_value`, payment period, hold, cancellation, renewal) + `m_refund` |
| `0014` | `login_type` (13 WL client types) + `is_teacher_type`; `teacher` view redefined to join it |
| `0015` | `session` booking fields (`i_wait`, `is_event`, `is_virtual`, `is_wait_list_enabled`, `url_book`) |
| `0016` | `attendance` booking facts (`is_waitlisted`, `is_unpaid`, `uid_book`) |
| `0017` | `session` visit detail (`is_checkin`, `k_service`, `dt_cancel_by` — a deadline, not a cancellation) |
| `0018` | `purchase_item` session counts (`i_limit`, `i_left`, `i_remain`, `i_use`, `i_book`, `i_buy`) |
| `0019` | `session.detail_fetch_count` / `detail_fetched_at` — bounds the per-visit detail re-read |
| `0020` | `session_outcome` view — what happened to each booking, derived in one place |
| `0021` | `session.is_request` / `is_confirmed` / `is_denied`; `is_countable` on the outcome view; two new health issues |
| `0022` | `person.ghl_match_attempted_at` — separates "never searched" from "searched, not found" |
| `0023` | `person.ghl_unresolved_since` — a clock retries do not reset; the 48-hour GHL alert; `ghl_contact_id` documented as deliberately non-unique |
| `0024` | `raw_ghl.person_uid` — which client a stored GoHighLevel response was fetched for, so "stored alongside" is a link and not a grep |
| `0025` | `sync_queue_progress` and `ghl_match_progress` views — per-stage "how many done, how many pending" queryable from SQL editor |
| `0026` | `ghl_contact` + `ghl_custom_field` — GoHighLevel fields and tags keyed by **contact**, not person; the agreed field list as data (`is_reported`) rather than columns; `client_ghl` and `ghl_enrichment_missing` views; two new health issues; backfills 317 clients from stored `raw_ghl` payloads with no API call |
| `0027` | `person.is_active` — whether WL lists a client as activated (report `o_member_status` 3). A boolean, because WL exposes no per-row status and only that one filter restricts; null until the client-list report has seen them. Not derived from `text_login_type` — type is not status |
| `0028` | `purchase.m_refund` — the refund is a fact about the **purchase**, not the item; `purchase_item.m_refund` is an echo and must never be SUMmed (summing it inflated refunds up to 4× and made 38 purchases look over-refunded). Adds `purchase_net`, `revenue_month`, `active_client` and `purchase_over_refunded` views |
| `0029` | `attendance.id_visit` — WL's own visit status (`WlVisitSid`), the only field that says what happened. `is_attended` was written from `is_checkin` ("ready to be checked in", true on 0 of 4,423 sessions) and is now derived from `id_visit` and **nullable**; `session_outcome` and `is_countable` read the status; adds `visit_awaiting_staff` |
| `0030` | `attendance.dt_checkin_utc` — WL's `dt_register`, "the date the client checked in", present on 55 of 55 sampled records and previously discarded. Evidence beside the verdict: nothing derives from it. Class-only — the appointment record does not carry it, so it does NOT answer Q9; that still needs `is_arrive` from the StaffApp schedule list. Adds `visit_unresolved_past` — sessions that ran while WL still says BOOK, which `visit_awaiting_staff` misses because WL is not asking anybody |
| `0031` | `sync_job_state.window_start_override` / `window_end_override` — a ONE-SHOT manual sync window, consumed by the next clean drain. Beside the derived rule, not instead of it: a stored cursor that advances past an interrupted run loses that work silently. Adds `sync_window_override`, normally empty |
| `0032` | `enqueue_sync_items()` — queueing in one atomic statement; PostgREST cannot write `ON CONFLICT DO NOTHING` against a partial index |

`supabase/checks/` holds read-only verification scripts — RLS bypass and isolation
proofs, plus case tables for rules that live in SQL. They are not migrations and
change nothing.

| Check | Proves |
|---|---|
| `session_outcome_cases.sql` | every `session_outcome` case, and `is_countable` where it disagrees with the outcome |
| `ghl_match_cases.sql` | the GoHighLevel outcomes: a shared contact stays legal, an unlinked client stays visible, no link is ever invented, and the 48-hour boundary |

A rule derived in a view is tested in SQL rather than mirrored into TypeScript.
Copying it into vitest would give the suite a second definition to disagree with —
the exact thing deriving it in one place was meant to prevent.

## How a sync pass runs

```
loadConfig()                     fail closed if anything is missing
  │
  ├─ ensureAuthenticated()       one token, before any data call
  │
  ├─ runBatch(steps)             concurrent, budget-aware
  │    │
  │    └─ per item: client.request()
  │         ├─ traceId assigned
  │         ├─ status === "ok" asserted
  │         ├─ transient? backoff and retry (WL Retry-After wins if short)
  │         └─ spent / long Retry-After? throw with requeueAfterMs
  │              (WL's delay, else the rung the prior-attempt count picks)
  │
  └─ summary { runId, steps, skipped, tokenFetches }
```

**Authenticate first, always.** A bad credential found on call one of three
thousand is the same failure as one found up front, but only one of them is
legible in a cron log.

**The budget is checked before starting an item, never mid-flight.** Abandoning a
call already in flight leaves the API doing work nobody reads. Whatever was never
started comes back in `remaining`, so the next invocation resumes with exactly
those.

## What a sync run costs

Measured live 25 Aug 2026 against 22 clients, 109 purchase items and 109 sessions.

| Pass | Calls | Scales with |
|---|---|---|
| login type, staff, location, shop category | 4 | fixed |
| promotion, service category, service catalogue | 3 | locations |
| profile | 20 | **people** |
| purchase list | 20 | **people** |
| purchase element | 109 | **purchase items** |
| receipt | 0 | unpriced purchases only (fill-only) |
| schedule | 1 | fixed |
| attendance | 6 | class occurrences |
| client visits — list | 22 | **people** |
| client visits — detail | 115 → **0** | see below |

**~155 calls in the steady state**, roughly `7.5 × clients + 5`.

The client-visit detail half was the one unbounded piece: before task 7.3 it
re-read all 115 upcoming visits on every run, so a thousand clients meant several
thousand calls a day against limits WellnessLiving has never told us. It is now
capped at **two reads per session** — once on discovery, once after the session
has happened — and anything more than a week past its start is never re-read at
all. On a client whose sessions have all settled the pass costs **one list call**.

## Conventions

**All WellnessLiving keys are `text`.** They arrive as JSON strings and `k_` values
are text throughout. As integers a leading zero is lost.

**Money is `numeric(12,2)`, never float.** WL sends `"280.00"` as a string. A
rounding error inside a royalty percentage is a support ticket.

**`dt_` is UTC, `dtl_` is local.** WL's own convention, confirmed live. Purchases
store UTC only; sessions store both — see [DATA-MODEL.md](DATA-MODEL.md).

**Composite keys are joined with `|`** when they have to live in one text column,
in primary-key order. Used by `sync_queue.target_key`, `raw_link.record_key` and
`raw_wl.target_key`.

**Hosts never appear in source, logs or stored records.** A host is configuration.
[`tests/no-hardcoded-config.test.ts`](../tests/no-hardcoded-config.test.ts) scans
`src/` and `api/` and fails if one appears.

**Tests are named after the behaviour, not the function.** And a test that cannot
fail is not a test — behaviour is verified by mutation, not by watching green.
