# Status and plan

Last updated **18 Sep 2026**. Keep the date honest — a stale status file is worse
than none, because it is believed.

## The plan

| Phase | Scope | Status |
|---|---|---|
| **M01** foundation | Config, secrets, auth, HTTP client, retry, logging, health | ✅ done |
| **M02** schema | Tables for people, money, sessions, control plane, raw payloads | ✅ done |
| **M03** sync engine | The code that reads WL and writes to those tables | ✅ done — 17 passes, 6 scheduled jobs, live |
| **M04a** GHL matching | Contact matching against GoHighLevel | ✅ done — `src/ghl/`, `ghl_match_sync` runs nightly |
| **M04b** royalty calculation | The number this project exists to produce | ⬜ **not started — this is the next work**. Its missing input got closer on 17 Sep: WL's own transaction reports carry a revenue category (see below) |
| **M05** portal | Student portal reading the same database | ⬜ not started |

**M03 is complete and running unattended.** Seventeen passes read WellnessLiving
into eighteen tables, grouped into six named jobs on their own crons, with a lease
so no job overlaps itself, a durable queue as the cursor, a monthly re-read for
retroactive edits, and an alert sweep that mails when a job stops running. Operating
it is documented in [RUNBOOK.md](RUNBOOK.md); what it collects is documented in
[DATA-MODEL.md](DATA-MODEL.md).

**What is left is the calculation itself.** Everything above is input. The royalty
number — the thing the project is named for — has not been written. See "Not
started" below.

### Incident, 18 Sep 2026 — the sync was dead for four days and nothing said so

Found by comparing our numbers against WellnessLiving's own reports, by hand. Not
by an alert, because the alert was broken by the same cause.

**The chain, in order.** `CRON_SECRET` was not set on the Vercel project. Vercel
Cron only sends an `Authorization` header when that variable exists, so every cron
arrived with none; [`src/http/bearer.ts`](../src/http/bearer.ts) correctly refuses
an unconfigured secret, and every invocation returned **401 in about 5ms having
reached nothing**. `client_session_sync` therefore had not run since **14 Sep**.

**What that cost, measured.** Appointment outcomes come only from
`client-sessions.ts`, and a visit is read once when booked and again after it
happens. With no runs, the second read never came:

| Week | Total | WL says attended | We said |
|---|---|---|---|
| 14 Sep | 190 | — | **1** |
| 7 Sep | 177 | 135 | 108 |
| 31 Aug | 207 | — | 173 |
| 24 Aug and earlier | ~150–200 | — | ≈ total |

Everything to 24 Aug is healthy, so the damage is bounded to two weeks.

**Three things made it silent, and each is worth keeping in mind.**

- **The watchdog shared the failure.** `/api/alerts` 401s like everything else, so
  the one check designed to notice that nothing happened did not happen. It is now
  the only sync-adjacent thing left on Vercel's clock, deliberately.
- **`rows_fetched` is 0 on every `sync_run` row**, including a 7-minute one. A run
  reads as `ok` whether it did everything or nothing. Looking at the run table
  would not have found this. **Not fixed.**
- **`SESSION_IMMUTABLE_AFTER_DAYS = 7` assumes somebody looked.** A visit older
  than a week is never re-read, whatever its state — the rule has no notion of "we
  were not running". That is what turned an outage into permanent bad data.

**What was recovered, and what was not.** The 14 Sep week came back: `attended` 1 →
104 and rising, driven by hand through `/api/sync-job?job=attendance-close` plus a
one-shot window override (`/api/sync-window`) once it emerged that
`SYNC_DAILY_LOOKBACK_DAYS = 3` was excluding 14 Sep from the past-visit list.
**The 7 Sep week cannot be recovered** by the current code: ~30 visits are past the
seven-day rule, and reopening them needs either a code change or a targeted
re-read outside the pass. Left wrong, knowingly, and recorded here because the
royalty calculation is not written yet and must not read that week as fact.

**Two things are still open from this.** `/api/wellness-sync-all` returns **500**
(cause not yet measured — the route's `detail` field has not been read), and ~60
visits in the 14 Sep week remain `BOOK` because their queue items completed within
the 24-hour fresh-done window and will not re-seed until it lapses.

### The schedule left Vercel, 18 Sep 2026

A consequence of the above, and of a limit that was always there. The project is
on Vercel's **Hobby** plan: two cron entries, once a day each, 60-second functions.
Ten crons were configured. Draining one queue that day took **six invocations** —
one run a day would have taken a week.

So `sync:full-parallel` now runs hourly on a GitHub Actions runner, which has no
60-second cap, and Vercel keeps the two crons it can honour: `/api/alerts`, the
watchdog that must not share a failure with the thing it watches, and
`/api/wellness-sync-all` as a safety net. The named jobs are unchanged and still
callable at `/api/sync-job?job=<name>`. See section 7 of
[RUNBOOK.md](RUNBOOK.md).

**Nothing about the Vercel account changed**, which was the constraint asked for.

### How M03 got here

The rest of this section is the record of how each piece landed and what was
measured at the time. It is history, not current state.

The staff path (`person`) and
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

**Schedule cadence closed the retroactive-edit gap** (1 Sep 2026). The daily
windows are short by design - 3 days for appointments, 7 back for the class
schedule - which left a session edited weeks after it ran outside every window
and never re-read. The monthly route now derives its own range when nobody has
asked for one (`SYNC_MONTHLY_LOOKBACK_MONTHS`, default 2) and widens the
appointment window to match, so every calendar month is re-read once in full
shortly after it ends. An explicit ask still wins; 0 switches the cadence off.
Nothing else needed it: every other pass is unwindowed and enumerated in full
each night.

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

**815 tests across 69 files.** CI runs format, lint, typecheck, tests, a
fail-closed startup assertion, and gitleaks over full history on every push.

### Schema — 18 tables live on dev Supabase

`0001`–`0035` applied; **`0038` written 17 Sep 2026 and NOT yet applied** — see "In progress"). See [DATA-MODEL.md](DATA-MODEL.md) for what each holds and
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

### The two transaction reports — code complete, waiting on one migration (17 Sep 2026)

WellnessLiving's integrations team named two reports on `POST /v1/report/query`:
**739 "All Transactions (Item View)"** and **799 "All Transactions (Payment
View)"**. Both were probed live against dev the same day and both work.

| | 739 | 799 |
|---|---|---|
| Fields | 141 | 140 |
| Rows, `1980-01-01 .. today` | **10,913** | **10,196** |
| Pages at `i_limit` 1000 | 11 | 11 |
| Full-history build time | **90s** | ~60s |
| A 7-day window | 62 rows, **6s** | — |

**What is built:** migration `0038` (`pay_transaction`, `pay_transaction_item`),
`src/sync/transactions.ts`, `src/sync/tx-window.ts`, two passes
(`tx_item_sync`, `tx_payment_sync`) in a new `transactions` job group on its own
cron at 03:45, both also in the parallel full sync, the monthly route widened to
re-read them over the last `SYNC_MONTHLY_LOOKBACK_MONTHS` months, and 33 new
tests. `npm run verify` is green at **815 tests across 69 files**, and two
guarantees were mutation-proven: recomputing the window instead of reading the
frozen one, and accepting a page from an unfinished build, each turns the suite
red.

**What it is waiting on, and it is not code:** `0038` has to be applied to dev.
There is no DDL path in this repository — the service role key reaches
PostgREST only and no Postgres connection string exists in any config — so the
migration is run in the Supabase SQL editor, the same way `0001`–`0035` were.
Until then both passes have nothing to write to and the first (1980 → today)
load has not run.

**Three things worth knowing before using these tables.**

*They are not a replacement for the purchase path.* The item report returns
10,913 rows for all time against 20,561 `purchase_item` rows here: it lists only
items a money movement touched. Free, comped, unpaid and never-charged items
appear in neither report. The two sources must be reconciled before either
produces a royalty figure, and **that reconciliation is not written**.

*A refund finally has a date.* `purchase.m_refund` carries none, so a refund has
always landed in the original purchase's month. In the reports it is its own
negative row with its own `dtu_date`.

*A queued build on these reports returns ROWS* — fifty of them, from the previous
build — where the client-list report returns an empty list. "We got rows" is
evidence of nothing here, and the page reader now refuses outright to return
rows from an unfinished build.

The next work after that is still the royalty calculation — see below.

One item is carried, and it is not code: **nobody unfamiliar with this system has
yet tried to recover it using the runbook alone.** Every other check on that
runbook confirms the document exists and its commands are real; only that one
tests whether it can be followed under pressure. 30 minutes, one engineer who did
not build this.

Historical note: `0010_health_views_and_rls.sql` is applied to the live database and its
isolation proof passed (task 007): the five SELECT policies exist, all six views
(`client`, `teacher`, `data_health`, `data_health_issue`, `customer_journey`,
`enrollment_margin`) run with `security_invoker = on`, and the isolation test
confirmed a user reads only their own rows while anon reads none — run cleanly in
the Supabase SQL editor with no error and no test data left behind.

## Not started

**The royalty calculation.** This is the next real piece of work, and the only
part of the original scope not built:

```
purchase_item (the royalty row) ──> calculation ──> a reportable figure
```

Every input it needs is being collected nightly. What is missing is the rule: which
purchase items count, how they are grouped, and what the studio is actually billed
on. That rule is not recorded anywhere in this repository — it needs the client, not
more code, and it should go through a PRD before anything is written.

Two limits are already known and will not be removed by writing the calculation.
Say them when reporting any number (they are also in RUNBOOK.md section 9):

- **Any client count is a floor, not a total** — WL has no endpoint that enumerates
  clients (blocker 1).
- **Margin and profit cannot be computed at all** — WL never returns staff pay
  amounts (blocker 2). Revenue per class is available; profit per class is not.

**M05**, the student portal, remains not started.

## Measured 31 Aug 2026 — `id_visit` is read by the view but written by nothing

Migration 0029 made `attendance.id_visit` the field the royalty rule turns on.
Measured on live dev the same day, read-only:

| | |
|---|---|
| `attendance` rows | 4,431 |
| `id_visit` **is null** | **4,431 — every row** |
| `session_outcome.is_countable = true` | **0** |
| stored `/v1/schedule/page/element` payloads in `raw_wl` | **4,990** |
| `attendance.k_visit` present | 4,431 — every row |

0029 added the column and rebuilt the view to require `id_visit = '3'`, but the
column starts empty and no pass has run since. `client-sessions.ts` does write it;
`attendance.ts` does not, even though `id_visit` is in the payload it already
receives (55 of 55 client records — see WL-API-NOTES.md).

**Keep this in proportion.** Only **32 of 4,423** sessions are in the past — the
other 4,391 are upcoming. So `is_countable = 0` is mostly "almost nothing has
happened yet", not "the data was lost". The defect is that the column is empty,
not that a month of royalties is missing.

**The cheap fix was a re-parse, not a re-sync — and it is done.** Those 4,990
stored payloads each carry `id_visit` (200 of 200 sampled), and every attendance
row has its `k_visit`, so the gap was closed with **zero WellnessLiving calls**.
Re-parsed and applied 31 Aug 2026:

| | before | after |
|---|---|---|
| `attendance` rows | 4,431 | 4,431 |
| `id_visit` is null | **4,431** | **0** |
| `is_attended = true` | 0 | 3 |
| `session_outcome.is_countable` | 0 | 0 |

### Why `is_countable` is still 0 — and why that is correct

Measured the same day, each condition the view requires, counted separately:

| Condition | Rows passing |
|---|---|
| `id_visit = '3'` (ATTEND) | 3 |
| session has already started | 34 |
| **`is_reviewed = true`** | **0** |
| not a booking request / not studio-cancelled / not waitlisted | 4,431 each |

**`is_reviewed` is the only thing standing in the way, and it is ours, not
WellnessLiving's** (0010). It is studio-review workflow state, `not null default
false`, set by whoever reviews — nothing in WL supplies it. So zero countable
sessions is the schema doing exactly what M08 asked for: *"sessions not yet
reviewed by the studio are stored and visible, but never counted as attended"*.
Nothing is broken here; the pipeline is waiting on a human.

### Then appointment attendance was read for the first time — 31 Aug 2026

The backfill above left 4,425 BOOK against 3 ATTEND, and 29 past sessions reading
`unknown`. That was not WellnessLiving being vague: `/v1/login/attendance/list`
had never been called for an appointment, because sending the appointment key as
`k_class_period` returns `id-nx` and that was recorded as "the endpoint is
class-only". It is `k_appointment`. The pass now picks the parameter from
`session_kind`, and the queue drained **4,441 done, 0 requeued, 0 dead** — against
681 dead out of 1,018 before.

| `attendance.id_visit` | after backfill | after appointment sync |
|---|---|---|
| 1 BOOK | 4,425 | 4,371 |
| 3 ATTEND | 3 | **19** |
| **6 CANCEL** | **0** | **26** |
| 7 PENDING | 3 | 15 |

| `session_outcome.outcome` | after backfill | after appointment sync |
|---|---|---|
| `upcoming` | 4,396 | 4,371 |
| **`unknown`** | **29** | **0** |
| `attended` | 3 | 19 |
| **`client_cancelled`** | **0** | **26** |
| `awaiting_staff` | 3 | 15 |

Two things to take from this.

**The 29 `unknown` rows were not ambiguous data — they were unread data.** Every
one resolved into a real outcome. `visit_unresolved_past` (0030) still earns its
place, but it now reports 0 rather than 29.

**Client cancellation is in the database for the first time — 26 of them.** This
is the M08 blocker that read "client cancellation is not reported anywhere in the
API" closed with evidence: WL reports it as `id_visit` 6 (CANCEL, in time) and 4
(PENALTY, too late). What is still not published is a cancellation *timestamp* on
the endpoints this project calls — see WL-API-NOTES.md for the two that do carry
one and why neither is wired up yet.

All 19 attended visits are already past, so `is_reviewed` remains the only thing
between them and being countable.

### An outcome is only as fresh as the last read AFTER the session ran

Within an hour of the run above, `session_outcome` showed **115 `unknown`** where
it had shown 0, and `visit_unresolved_past` (0030, applied the same day) reported
the same 115. Nothing regressed — this is the pass working exactly as designed and
the design having a consequence nobody had written down:

**A session read while it is still upcoming records BOOK, and nothing re-reads it
once it has happened.** Those 115 started between 27 and 30 Aug. When the sync ran,
they were in the future, so `id_visit = 1` was WellnessLiving's correct answer.
Time passed; the answer went stale; the row did not.

Two things follow.

**The attendance pass has to run on a schedule, not once.** It is not a backfill
that completes. A session's outcome is settled only after it runs, so the useful
cadence is "daily, over anything that has started since the last pass" — and
because every write is an upsert on a WL key, re-reading is always safe.

**`visit_unresolved_past` is the thing that makes this visible**, and it earned its
place immediately: it went from 0 to 115 and named exactly which sessions had gone
stale. Without it those rows read `unknown` in a column nobody watches.

A caveat on the dates in this batch. The machine clock moved forward roughly four
days mid-session — git stamped these commits `27 Aug 2026` while the database and
the OS now both read `31 Aug`. Measurements taken in this batch are dated **31 Aug
2026**, which is when they were actually taken; the commit timestamps are wrong and
were left alone rather than rewriting history. It is also part of why the 115
appeared: the clock correction moved four days of sessions into the past at once.

### Coverage, measured 31 Aug 2026

Everything below is read-only counting, no WellnessLiving calls:

| | |
|---|---|
| `person` | 1,285, of which **517 `is_active`** — matches the portal's 517 exactly |
| matched to a GoHighLevel contact | 317 |
| `session` | 4,423 — 11 class, 4,412 appointment |
| `session_staff` | 4,423 — **every session has a teacher attached** |
| `purchase` / `purchase_item` | 20,347 / 20,561 |
| `purchase_payment` | 19,975 |
| `purchase_account_credit` | 19,438 — the prepaid-credit breakdown M06 requires |
| `sync_queue` | every work type fully drained, 0 pending, 0 failed, 0 dead |

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

## A view is rewritten whole, and that has already cost us twice

`data_health_issue` cannot be appended to - Postgres makes you write the whole
thing out - so a branch nobody retypes simply vanishes. It has happened:

* `0023` added `ghl_unresolved_48h` (board item M05's 48-hour alert) and pointed
  the three GoHighLevel rows at `ghl_unresolved_since` so `data_health.oldest`
  meant something. `0026` recreated the view from an older copy and **silently
  lost both**. Nothing failed. The alert simply stopped existing, and `oldest`
  went back to resetting on every sync.
* Found 31 Aug 2026 only because `0033` had to touch the view too, and the live
  view was checked against the file before rewriting it.

**Before recreating `data_health_issue`, list the live view's branches first**
(`select distinct issue from data_health_issue`) and diff them against what you
are about to write. The file in `supabase/migrations/` is not the authority -
the newest migration that recreated the view is, and that is easy to miss.

## Decisions waiting on someone

**`WL_REQUESTS_PER_SECOND` is set and read by nothing (31 Aug 2026).** It sits in
`.env` at 2, and a grep across `src/` and `api/` finds no reader. The live drain
ran at 1,591 items/min - roughly 26 requests/second - so nothing is throttling
WellnessLiving at all. WL has never pushed back, so this is not urgent, but a
knob that looks like a safety limit and is not is worse than no knob. Either wire
it up or delete it.

**`attendance.synced_at` says when a row was first written, not when it was last
confirmed (31 Aug 2026).** The writer never sends the column, so its `now()`
default only fires on insert. After a full re-check of all 43,733 rows, not one
of them reported having been confirmed. `data_health`'s staleness checks read
this column.


**Which GoHighLevel fields to report — no longer blocks M06 (27 Aug 2026).**
M06 is built and the ticket can close. The blocker was self-inflicted: "the
agreed fields" was being modelled as **columns**, so nothing could be built
before the list arrived. Migration 0026 models it as **data** instead —
`ghl_contact.fields` stores every custom field the contact carried and
`ghl_custom_field.is_reported` says which may be shown, so confirming the list is
an `UPDATE`, not a migration and a backfill.

The re-parse promise was kept literally: 0026 backfilled 317 clients out of the
1,098 already-stored `raw_ghl` payloads with **zero** GoHighLevel calls.

**Still needed from the client, but nothing waits on it:**

| Question | What happens meanwhile |
|---|---|
| Which fields to report | `is_reported` is false on all of them, so no field appears on a client record. One `UPDATE` turns each on |
| What the fields are called | `ghl_custom_field.name` is null and `client_ghl` falls back to the id. Measured: exactly **three** field ids exist in this location's data — `ibhlYPvuAeAA3N8iJqv6` (54 contacts; values `DJ`, `PIANO`, `LIVE SOUND`, `VOICE`, `MUSIC PRODUCTION`), `7NBvgQs2s08waeVnsl6J` (21, free text), `f48pVfYaewIDJl35G1X1` (2). So the conversation is "here are your three fields", not "please send a list" |
| Replace or merge on tags | **Decided: replace.** Many tags are operational state GoHighLevel retires, and merging would strand them permanently. `raw_ghl` keeps every fetch, so it is reversible |

The one thing to know rather than fix: enrichment is **fetched once** at match
time and never refreshed, so `fetched_at` is the date of the match, not of the
data. `data_health_issue.stale_ghl_contact` reports that age past 30 days
deliberately, and will not clear while nothing refreshes — it states an age for a
reader, not a queue of work. If it ever needs to be actionable, the honest fix is
a refresh route, not a longer interval.

**Field id → name is unreachable with the current token.** The mapping lives at
`GET /locations/{id}/customFields`, which answers **401** for a contacts-scope
Private Integration Token. Adding `locations.readonly` in GHL → Settings →
Private Integrations would let the names be fetched instead of asked for.


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

These are the **pre-build estimates**, kept because they are what the design was
sized against. They are no longer the best source for how the sync behaves: it now
runs in production, and RUNBOOK.md section 7 carries per-pass medians, p90s and
observed maxima measured over 26,516 `sync_run` rows. Prefer those when sizing
anything new.

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
