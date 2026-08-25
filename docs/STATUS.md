# Status and plan

Last updated **24 Aug 2026**. Keep the date honest — a stale status file is worse
than none, because it is believed.

## The plan

| Phase | Scope | Status |
|---|---|---|
| **M01** foundation | Config, secrets, auth, HTTP client, retry, logging, health | ✅ done |
| **M02** schema | Tables for people, money, sessions, control plane, raw payloads | ✅ done |
| **M03** sync engine | The code that reads WL and writes to those tables | 🔨 in progress — staff path live |
| **M04** GHL + royalty | Contact matching, royalty calculation | ⬜ not started |
| **M05** portal | Student portal reading the same database | ⬜ not started |

**M03 is running staff and purchases against dev.** The staff path (`person`) and
the purchase path (`purchase` + `purchase_item`, the royalty rows) both run end to
end — Supabase write client, writers with `raw_link`, the durable `sync_queue` loop
with per-work-type claiming, and bounded `sync_run` passes. A live run wrote 109
purchases + items across the staff uids. **Money now lands too** (task 015): a
receipt pass fills `purchase` totals, `purchase_item.m_price_total`,
`purchase_payment` and `purchase_account_credit` from `/v1/purchase/receipt` — proven
live (totals like 840/299/280, payment + account-credit rows). Each pass also now
records a `sync_job_state` row — `running` → `idle`/`paused`/`failed`, with
`last_clean_completion_at` moved only on a clean drain (the watermark a future
incremental sync will trust). The receipt pass also fills the **payer as printed**
(`purchase.payer_name/email/phone` from `a_customer`, added 24 Aug 2026 — shape per
the WL Postman collection, live confirmation tracked in task 008). **The recipient
now lands too** (24 Aug 2026): a `purchase_element_sync` pass fetches
`/v1/profile/purchase/list/element` per purchase item and fills
`purchase.uid_recipient` — with a person stub first so the FK holds, a fill-only
write (never overwrites), and a `sync_conflict` parked when two items of one
purchase disagree (the first real use of that table). Proven live: 109/109
purchases attributed across three bounded passes, 0 conflicts, 0 dead, and a
re-run seeded nothing. **Profile enrichment (P6.1) now lands too** (24 Aug 2026): a
`profile_sync` pass fetches `/v1/user` per person and merges the client's contact
detail onto `person` — crucially the **primary email**, which appears nowhere else
(the client report exposes only a secondary email), so this is the enrichment GHL
matching waits for. Merge never clobbers (WL's `""` is read as null and omitted), a
failed profile parks without stopping the others, and upsert-on-uid keeps a re-run a
refresh not a duplicate. Proven live: 20/20 people enriched with email/phone/DOB.
Coverage is bounded by who we can enumerate (staff + purchase payers/recipients) —
the wider client base still needs the client-list unblock (blocker 1).
**Membership and refund detail (P6.2) now lands too** (24 Aug 2026): the element
pass — renamed `purchase_element_sync`, because it now takes two things from one
payload — also fills `purchase_item` with `sid_value`, payment period, period
price, hold state and dates, pending cancellation, renewal and `m_refund`
(migration `0013`). The board said these come from the purchase list; a live probe
over 109 items proved they do not — that endpoint returns eighteen identity fields
— so they are read from the element payload already being fetched, at no extra
API call. The pass now seeds EVERY item rather than only unattributed ones,
because membership state changes where a recipient does not. Still to come:
the `sync_job_state` **page cursor**
(`page_number`/`report_handle`, unused until a paginated endpoint like
`/v1/report/data`); `sync_conflict` creation; and the full client base (blocked
upstream — no client-list endpoint). **Location and service detail (P5.6) now land**:
`location/list` fills `location.title` + timezone, and `service.title`/`is_package`
are derived from purchase items (WL exposes no service-detail endpoint).
**Reference lookups (rest of P5.6) now land too**: `promotion` (per-location,
`/v1/classes/promotion`) and `shop_category` (business-wide, `/v1/shop/category`)
have migration `0011`, writers, queue passes and tests — both endpoints probed live
24 Aug 2026 and both return JSON arrays, not keyed objects. Proven live: the passes
wrote 5 `shop_category` and 12 `promotion` rows, and a promotion re-run stayed at 12
(upsert, no duplicates). **Service catalogue (last of P5.6) now lands too**: the real
catalogue was found live under `/v1/appointment/book/service/{list,category}` (task
020's "no service endpoint" was only true for the `/v1/service*` family), so migration
`0012` adds `service_category`, enriches `service` with title/category/duration, and
introduces `service.is_resolved` + the `unresolved_service` view. A service in the
bookable list is `is_resolved = true`; a service only ever referenced by a transaction
stays `false` and is countable as the Q19 gap (9 bookable vs ~200 referenced). The
"unresolved service" behaviour is live for **purchases**; the same stub-don't-fail
pattern now covers **sessions** too - attendance populates (see below).

## Done

### Foundation

| Area | Where |
|---|---|
| Config with three secret providers, fails closed | `src/config/`, `src/secrets/` |
| WL OAuth2 with a shared, self-refreshing token cache | `src/wl/token.ts` |
| WL client asserting `status === "ok"` centrally | `src/wl/client.ts` |
| Failure classification: auth / transient / permanent | `src/wl/client.ts` |
| Backoff 1s/5s/25s, requeue 1/5/25 min (rung from prior-attempt count), jittered; WL Retry-After honoured, requeued if too long to sleep | `src/wl/retry.ts` |
| Batch runner: pooled, budget-aware, resumable | `src/wl/batch.ts` |
| Internal trace ids, `runId.seq` | `src/wl/trace.ts` |
| Structured logging, redaction before fan-out, optional files | `src/logging/` |
| Health probes for WL and Supabase | `src/health/`, `src/wl/health.ts`, `src/supabase/health.ts` |
| Shared constant-time bearer check for routes | `src/http/bearer.ts` |
| Vercel health endpoint | `api/health.ts` |

**208 tests across 17 files.** CI runs format, lint, typecheck, tests, a
fail-closed startup assertion, and gitleaks over full history on every push.

### Schema — 18 tables live on dev Supabase

`0001`–`0009` applied. See [DATA-MODEL.md](DATA-MODEL.md) for what each holds and
why it is shaped that way.

### Tickets closed

| Ticket | |
|---|---|
| Supabase projects created and reachable | ✅ dev and prod |
| Repository skeleton, CI | ✅ |
| Per-environment settings | ✅ |
| Secrets management | ✅ (local `.env` / settings file; Secrets Manager unused) |
| HTTP 200 error handling | ✅ |
| Rate limiting and retry | ✅ (limit later removed as unjustified) |
| Trace ids | ✅ internal; WL's own is unreliable |
| Person model | ✅ |
| Purchase / payment / service | ✅ |
| Session / attendance | ✅ |
| Sync tracking tables | ✅ |
| Raw payload tables | ✅ |
| Health views and RLS | ✅ applied + proven on the live DB (21 Aug 2026) |

## In progress

Nothing. `0010_health_views_and_rls.sql` is applied to the live database and its
isolation proof passed (task 007): the five SELECT policies exist, all six views
(`client`, `teacher`, `data_health`, `data_health_issue`, `customer_journey`,
`enrollment_margin`) run with `security_invoker = on`, and the isolation test
confirmed a user reads only their own rows while anon reads none — run cleanly in
the Supabase SQL editor with no error and no test data left behind.

## Not started

**M03, the sync engine.** This is the next real piece of work:

```
WL call ──> raw_wl ──> parse ──> typed tables + raw_link
                                      │
                                 sync_run / sync_queue updated
```

The pieces it needs already exist — client, retry, batch, trace, and every table.
What is missing is the writer.

**M04**, GoHighLevel matching and royalty calculation. Credentials work; there is no
`src/ghl/` yet.

## Blocked, and what unblocks it

### 1. No way to enumerate WL clients — the main blocker

`/v1/login/search/staff-app/list` requires a search term. There is no paged client
list, so `person` can only be filled from the 20 in `/v1/staff/list`, not the wider
client base.

**Needs:** WL integrations to confirm whether a client list or export endpoint
exists. Without it a full sync is not possible.

### 2. No staff pay amounts — margin cannot be computed

WL returns pay rate keys, never amounts, and none of its 75 documented endpoints
resolves them. `enrollment_margin` reports revenue with `teacher_cost` null.

**Needs:** either an endpoint we have not found, or the rates supplied another way
into `staff_pay_rate.m_rate`.

### ~~3. `/v1/login/attendance/list` returns `date-incorrect`~~ — RESOLVED 25 Aug 2026, AND IT WAS OURS

Recorded as a WL problem: "every date format tried fails, including the one other
endpoints require". **The date was never the problem — the parameter NAME was.**
It is `dt_date_local`, not `dt_date`, and it wants the occurrence's LOCAL start
time (`YYYY-MM-DD HH:MM:SS`) alongside `k_class_period`. Measured: `dt_date` is
rejected, a bare date is rejected, and the session's global time answers with an
empty list. Only the local time returns anything. The Postman collection
documented this correctly the whole time.

`attendance` now populates — 12 rows live, and it is currently the only route to
clients outside the staff list (both attendees of every session were people we do
not otherwise hold).

**The lesson, which is the reason this entry is kept rather than deleted:** two of
our four "WL blockers" turned out to be our own parameter mistakes — this one and
the schedule window, which wanted bare dates. Before recording a blocker, check
the supplied Postman collection against the call actually being made.

### ~~4. Nothing identifies a purchase's recipient~~ — RESOLVED 24 Aug 2026

Recorded as a blocker earlier the same day, then unblocked: the WL Postman
collection pointed at `/v1/profile/purchase/list/element`, which a live probe
confirmed carries `uid_recipient` per purchase item (see WL-API-NOTES). The
`purchase_element_sync` pass now fills `purchase.uid_recipient`. Still genuinely open
within it: a parent-child purchase (recipient ≠ payer) has never been observed on
dev — every sample is a self-purchase — so that path is mock-verified only
(task 008).

## Decisions waiting on someone

**Raw payload retention — now measured (24 Aug 2026, task 024).** `raw_wl` and
`raw_ghl` will outgrow every other table and hold the most personal data in the
database. A policy is needed **before the first full backfill**, not after. The
schema already supports one — `fetched_at` to age on, `processed_at` to know what
is safe to drop.

The size is no longer a guess: **~58 KB per client per full sync** (receipts are
42 KB of it), so **57 MB** per pass at 1,000 clients and **~20.3 GB** for a year
of daily syncs. Per-endpoint figures are in
[DATA-MODEL.md](DATA-MODEL.md). Task 023 sharpened this by re-fetching every
purchase item on every run instead of once.

**A re-parse path over stored payloads.** 6.3 justifies `raw_wl` on "revisit
decisions without re-pulling every client", and that half does not exist. On
24 Aug 2026, 73 receipts stored on 21 Aug — complete, `status: ok`, `a_price`
intact — could not be re-read to fill in money the writer had not yet been able
to parse, so all 73 were re-fetched from WL. `processed_at` /
`processed_by_run_id` / `process_error` / `parser_version` exist for this and are
unused. Worth its own task.

**Portal identity mapping.** `person.auth_user_id` links a Supabase auth user to a
WL uid, but nothing populates it. How does a student's signup find their `uid`?

**Rate limits.** We removed our invented 5 req/s. Before raising throughput
materially, ask WL what the real limits are rather than discovering them.

## Housekeeping

- **Rotate the prod Supabase service role key.** It was shared in a chat during
  setup, bypasses RLS, and is valid to 2036.
- **AWS Secrets Manager is unused.** The provider works; nothing is uploaded. Fine
  for local, but deployed environments should not read credentials from a file.
- **Prod WL and GHL credentials are placeholders.** `config/settings.prod.json`
  currently holds UAT values copied across as a stopgap, clearly marked. Prod cannot
  run a real sync until they are replaced.

## Reference numbers

Useful for sizing anything in M03:

| | |
|---|---|
| WL staff | 20 |
| …of which have a teaching flag | 14 |
| WL clients with "Staff Client Profile" | 47 |
| Purchases for one sampled client | 27 |
| Receipt calls for 47 clients | ~1,270 |
| Estimated calls for one full pass | ~1,780 |
| GHL contacts | 22,865 |
| Vercel function cap | 60s (step budget 50s) |
| Sequential cost of 20 staff + detail | 21 calls, 14.6s |
