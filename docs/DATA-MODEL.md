# Data model

18 tables and 6 views on Supabase. Every design decision below came from calling
the live API, and the evidence is quoted so a future reader can check it rather
than trust it.

Structure and module map: [ARCHITECTURE.md](ARCHITECTURE.md).
API findings behind these choices: [WL-API-NOTES.md](WL-API-NOTES.md).

## Layout

```
people      person, lead                     views: client, teacher
money       location, service, purchase, purchase_item,
            purchase_payment, purchase_account_credit
schedule    session, session_staff, attendance
staff pay   staff_pay_rate, staff_service
reference   promotion, shop_category, service_category
                   view: unresolved_service
control     sync_queue, sync_job_state, sync_run, sync_conflict
raw         raw_wl, raw_ghl, raw_link
health      views: data_health, data_health_issue,
                   customer_journey, enrollment_margin
```

Every table carries:

| Column | Meaning |
|---|---|
| `created_at` | when the row first appeared here |
| `updated_at` | when it last **changed** here — maintained by trigger |
| `synced_at` | when it was last **read back** from the source, changed or not |

`updated_at` needs the trigger. A `default now()` fires only at INSERT, so a
column defended by a default alone reports the creation time forever and every
"what changed recently" query is quietly wrong. `synced_at` earns its place by
answering a different question: a sync that finds nothing new moves `synced_at`
and leaves `updated_at` alone, which is how "confirmed unchanged an hour ago"
differs from "nobody has looked at this in a week".

## People

```
person (uid PK, k_staff UNIQUE)
   ├── view client     all persons
   ├── view teacher    where k_staff is not null
   └── lead (uid FK, nullable)
```

### One human, one row

Every record in `/v1/staff/list` carries **both** a `k_staff` (6 digits) and a
`uid` (8 digits), and all 20 of those uids also resolve as clients via
`/v1/user`. Split across two tables those 20 humans would be counted twice in
royalties, so both ids live on the same row.

The join is free: WL puts the client `uid` directly onto the staff record, so no
matching heuristic is needed.

There is deliberately **no `is_staff` flag** — a non-null `k_staff` is the answer,
and two places holding the same fact is how they come to disagree.

### `client` and `teacher` are views, not tables

The ticket asked for both separate tables *and* a single row carrying both ids.
Those pull opposite ways; the row won, because that is the requirement with a
reason attached. The views give the names without storing anything twice.

Both use `security_invoker = on`. Without it a view runs with its owner's
privileges and reads straight past RLS on `person`.

### What does **not** identify a teacher

| Approach | Result |
|---|---|
| `text_login_type = 'Staff Client Profile'` | ❌ 47 clients carry it; only 20 are staff. Over-counts by 27, under-counts by 3 |
| Teaching flags alone | ❌ 6 of the 20 staff have no flags and 0 services — finance, admin, operations. They are still staff |
| Present in `/v1/staff/list` | ✅ the authoritative list |

All 20 are stored, flags included, so redefining "teaches" is a `WHERE` clause
rather than a migration and a backfill.

### `text_member` is not `uid`

The WL UI shows "Client ID #" — that is `text_member`, a **different** identifier.
Observed 9 digits for one person and `""` for another, and it is only returned by
`/v1/login/search/staff-app/list`, never by `/v1/user`. Nullable, and unique only
where present.

### `lead`

A lead has no `uid` — it is a form submission, not an account. When it converts,
WL creates a client of type "Prospect" (`k_login_type` 1234074) and `uid` is
filled in, which is why it is a nullable column rather than a second table.

**It cannot be populated from the API today.** `/v1/lead/info` returns the form
*definition* only, and no endpoint lists leads. The form is business-configurable
— observed 4 fields keyed 299334/299335/299332/299336 — so `k_field_map` records
which key supplied which value.

## Money

```
purchase (k_purchase PK)
   ├── purchase_item (k_purchase_item PK)   ← THE royalty row
   ├── purchase_payment                     ← a_pay_method, an array
   └── purchase_account_credit              ← a_account_rest, an array
```

### The item is the row, not the purchase

One purchase carries several items. Keying on `k_purchase` would collapse them and
lose the per-item price a royalty is calculated from. Verified: `k_purchase`
143051749 holds `k_purchase_item` 147785701, and one client had 27 purchases.

### Membership state lives on the item, not on the purchase

A membership, a lesson package and a one-off appointment are all `purchase_item`
rows; what separates them is `sid_value` (`service-membership`, `service-limit`,
`class-period`, `appointment`). Hold, cancellation and renewal are therefore
per-ITEM columns, not per-purchase: one purchase can hold a membership that is on
hold beside a package that is not.

`m_refund` is stored **negative**, as WL sends it (`-280.00` live), and is null
when WL sent its no-refund marker — the string `"0"`. Null therefore means "never
refunded", which a stored `0.00` could not distinguish from "refunded nothing".

The three flags — `is_hold`, `is_cancel_pending`, `is_renew` — are `not null
default false`. WL always sends a real boolean, so `false` is an answer, and a
nullable boolean would force a three-way check on every read.

None of this is on `/v1/profile/purchase/list`, which carries eighteen identity
fields only. It comes from the element endpoint — see
[WL-API-NOTES.md](WL-API-NOTES.md).

### Money is `numeric(12,2)`

Observed verbatim from `/v1/purchase/receipt`:

```json
{"m_discount":"0.00","m_sum":"280.00","m_tax":"0.00","m_tip":"0.00","m_total":"280.00","text_currency":"usd"}
```

Every one is a quoted **string**. Stored at fixed precision, never float.

### Prepaid credit is a separate fact

The same receipt showed:

```json
a_pay_method   = [{"m_amount":"280.00","text_pay_method":"Account"}]
a_account_rest = [{"m_amount":"-700.00","text_method":"Account Balance"}]
```

The payment came from account credit; the −700.00 is the remaining balance, not a
payment. Folding them into one table would let a sum misstate revenue. Both are
arrays, so both are child tables — a purchase can be split across card, cash and
account in one transaction.

### Payer and recipient are both recorded

A parent buys lessons for a child: the money is the parent's, the service is the
child's. Royalty attribution follows the recipient, revenue reporting follows the
payer, so one `uid` would lose whichever question is asked second.

`payer_name` / `payer_email` / `payer_phone` are kept as printed on the receipt,
because WL returns them **without** a uid — the only record of who was billed when
the payer is not in our own table.

How each side is populated (as of 24 Aug 2026): `uid_payer` comes with the purchase
list (fetched per person, so the queried uid IS the payer); `uid_recipient` comes
from `/v1/profile/purchase/list/element`, one call per purchase **item** — the only
endpoint that says who a purchase was for (see WL-API-NOTES). Because WL's recipient
is per item and our column is per purchase, the first item fills it, an agreeing
item is a no-op, and a **disagreeing** item is parked in `sync_conflict`
(`recipient-differs-by-item`) rather than overwritten — per-purchase was chosen in
0002 and a silent overwrite would misattribute a royalty. The recipient may not be
enumerable as a client yet (no client-list endpoint), so a `person` stub
(uid + k_business only) is upserted first and the FK holds — the same
stub-don't-fail pattern locations and services use.

## Schedule

```
session (k_period, dt_start_utc)   PK is class + date
   ├── session_staff   who taught it, with is_substitute
   └── attendance      who booked, and what became of it
```

### The key is class plus date

`k_class` 268302 is the same class every week, so it identifies the class, not the
occurrence. This is how WL itself addresses one:

```
/v1/schedule/class/view?k_class_period=18448467&dt_date=2026-08-19 00:00:00
```

### Appointments and classes share the table

To a royalty they are the same thing: someone taught, someone attended, at a time.
They differ only in which WL key names the series, so `session_kind` says which and
`k_period` holds it, with a constraint that the matching provenance column is set.

### Sessions store local time; purchases do not

WL sends both:

```json
{"dt_date":"2026-09-07 04:00:00","dtl_date":"2026-09-07 00:00:00","text_timezone":"ET"}
```

Two independent reasons the local value is stored rather than derived:

1. **`"ET"` is an abbreviation, not an IANA name.** It does not say whether EST or
   EDT applied, and Postgres cannot convert with it. The local value is genuinely
   not recoverable from what WL gives us.
2. **A class is scheduled in local wall time.** "Tuesday 6pm" stays 6pm across a
   daylight-saving change while its UTC value shifts. The wall time is the fact.

Purchases keep UTC only, because a purchase is an *instant* and an instant is
fully described by UTC.

### Cancellation is two columns, not one flag

A studio cancellation earns nobody anything; a late client cancellation is often
still billable. One boolean would force that rule to be guessed at read time.
`attendance` additionally separates `is_late_cancel` and `is_no_show`.

### Teacher assignment is its own table

`/v1/schedule/class/view` returns `a_staff` as an **array**, each entry carrying
`is_substitute` and `is_quick_substitute`:

```json
{"k_staff":868220,"uid":"63746599","is_substitute":false,"s_position":"Multi-Instrumentalist Instructor"}
```

A single `k_staff` column on `session` could not record a substitute — and the
substitute is precisely who a royalty is owed to.

## Staff pay — structure only

`staff_pay_rate` and `staff_service` exist, but `m_rate` is **null and will stay
null** until rates arrive from somewhere other than the API.

WL returns pay rate **keys**, never amounts:

```json
a_pay_rate      = ["310036", "308721"]
a_staff_service = {"k_service":"142047","k_staff_pay":"310041"}
```

None of the 75 endpoints in WL's own Postman collection resolves a `k_staff_pay`
to a rate. So `enrollment_margin` reports revenue truthfully and leaves
`teacher_cost` and `margin` null — not zero, which would read as "this session cost
nothing". `cost_is_known` says whether a margin means anything.

## Reference lookups

`promotion` and `shop_category` are the business-wide lookups other rows join to —
what an offering or a storefront category is *called*. Both are keyed on the WL key
(`k_promotion`, `k_shop_category`, kept as `text`), so a re-sync upserts in place and
never duplicates.

### Promotions are per-location; shop categories are not

`/v1/shop/category` answers for the whole business with no `k_location`. But
`/v1/classes/promotion` **needs** a `k_location` (probed live 24 Aug 2026) — so the
promotion pass is seeded one job per `location` row. A `k_promotion` is unique across
the business, so the same promotion surfaces under several locations; the upsert on
`k_promotion` collapses those to one row. This is why the P5.6 note calling
promotions "business-wide, cheap" was half right: cheap, but per-location.

### These two lists arrive as arrays, not keyed objects

The house rule (CLAUDE.md) is that WL list endpoints return keyed objects. These two
are the measured exception: `a_promotion` and `a_shop_category` came back as JSON
**arrays**. The parsers accept either shape, so a keying change on WL's side cannot
silently drop every row. See [WL-API-NOTES.md](WL-API-NOTES.md).

## The service catalogue, and what "unresolved" means

`service` began (0002) as an FK stub the purchase writer left — key plus a title
*derived* from the purchase items that referenced it, because task 020 found no
service endpoint (all `/v1/service*` paths 404). Probed live 24 Aug 2026 the real
catalogue turned up under a different path family, `/v1/appointment/book/service/*`:

- **`/v1/appointment/book/service/list`** → `service` detail. Per-location, `a_service`
  a **keyed object** (the usual rule). Title is `s_service`, category is
  `k_service_category`, duration is `i_duration_real` (minutes). Every row from here
  is marked `is_resolved = true`.
- **`/v1/appointment/book/service/category`** → `service_category`. Per-location,
  `a_category` an **array**. `k_service_category` (text key), `s_title`, `i_sort`.

Both are per-location and seeded from `location`; the keys are unique business-wide,
so upsert dedupes across locations.

### `is_resolved` — the countable gap (Q19)

The bookable list is **not** the full catalogue: it returned 9 services at the one
live location while staff records reference ~200, and appointments point at services
the list omits. So a service that a transaction references but the catalogue never
lists must still store — it just cannot be *resolved*. `service.is_resolved` records
that difference:

- The catalogue writer sends `is_resolved = true`.
- The purchase writer **never sends the column**; a new stub therefore defaults to
  `false`, and — because a PostgREST upsert writes only the columns in its body — a
  later stub re-write can never flip a resolved service back to `false`.

`unresolved_service` (a view: `service` where `is_resolved = false`) makes the gap
countable — `select count(*)` is its size, the rows are which services to chase. This
is the "store cleanly as unresolved rather than fail the row" behaviour the board
asked for, applied to purchases today; the same stub-don't-fail pattern will cover
sessions once attendance is unblocked (see [STATUS.md](STATUS.md)).

### No FK on `service.k_service_category`

Kept as plain `text`, deliberately without a foreign key — the same reasoning as
`raw_link.table_name` and unresolved services: a service may name a category the
`/category` list does not return, and a hard FK would fail the whole row for a
missing lookup, which is the failure this design exists to avoid.

## Control plane

```
sync_queue       outstanding work, with an absolute next_attempt_at
sync_job_state   the cursor per job, including a report handle
sync_run         what each run did
sync_conflict    what needs a human
```

**Absolute times, not durations.** `next_attempt_at` is a timestamp. A duration
only means something relative to a process that is still alive; a timestamp is
still correct after a crash, a redeploy, or a fortnight in the queue.

**Claims carry a lease.** `claim_expires_at`, so a worker that dies cannot strand
an item in `in_progress` forever.

**`sync_run.run_id` is the id the code generates.** The same eight-hex value that
prefixes every `traceId` in the log, so a log line joins to its row with no
timestamp guessing.

**`partial` is a first-class run state.** The budget running out is the normal way
a run ends, not a failure. Folding it into `ok` would hide unfinished work; folding
it into `failed` would cry wolf nightly.

**`sync_job_state.report_handle`** exists because `/v1/report/data` is not addressed
by a record key — resuming a part-finished report needs the handle WL issued plus
the page reached, and handles expire.

## Raw payloads

```
raw_wl   ─┐
raw_ghl  ─┴─> raw_link ──> any typed row
```

### Why keep them

Several WL fields are still not understood — the session-count fields and prepaid
credit both have open questions. The original response beside the typed columns
means a field decoded wrongly today is re-derived from what we already hold.

The numbers make it concrete. One client had 27 purchases and each receipt is its
own call, so the money for 47 clients is roughly **1,270 requests**. GHL holds
**22,865 contacts**. A re-pull is hours against an API we do not control; a
re-parse is a query.

### What it costs — measured 24 Aug 2026

"Keep everything" is only a decision once the price is known. Measured against
live dev data, average payload per call:

| Call | Average |
|---|---|
| `/v1/user` (profile) | 2.4 KB |
| `/v1/profile/purchase/list` | 3.2 KB |
| `/v1/profile/purchase/list/element` | 2.2 KB |
| `/v1/purchase/receipt` | **7.7 KB** |

At dev's shape — 5.5 purchases and 5.5 items per client — that is **~58 KB per
client per full sync**. Receipts are 42 KB of the 58: the largest response, and
one per purchase.

Scaled: **57 MB** for 1,000 clients in one pass, **~20.3 GB** for a year of daily
syncs. Not alarming, not free. The retention question in
[STATUS.md](STATUS.md) is the decision this number exists to inform — and it got
sharper with task 023, which re-fetches every purchase item on every run rather
than once.

### Storable is not re-readable — and that gap is real

The justification above is "a re-parse is a query". It is not, yet.

On 24 Aug 2026 the money for 73 purchases was missing. Their receipts had been
fetched on 21 Aug — before the money writer (task 015) existed — and were sitting
in `raw_wl`, complete, `status: ok`, `a_price` block intact. Filling the money in
should have cost zero API calls. All 73 were re-fetched from WL instead, because
nothing can re-process a stored payload.

`processed_at`, `processed_by_run_id`, `process_error` and `parser_version` were
put on `raw_wl` for exactly this and are unused. Until something reads them, this
table buys evidence and audit, not the re-parse it was justified on.

### Two tables, not one

WL answers HTTP 200 for errors and puts its status in the body, and sends `k_log`
on only some endpoints. GHL uses real status codes and returns a `traceId` on every
response. One table would carry both column sets half-empty.

### One row per fetch, not per record

A list endpoint returns a page; a record endpoint returns one record; both are one
fetch. Storing 100 rows for a 100-contact page would multiply the payload by a
hundred. `target_kind` says which shape `target_key` holds.

### `raw_link` is many-to-many, and has to be

The first draft put a single `raw_wl_id` on each typed table, which assumes one row
comes from one fetch. It does not:

| Table | Fetch 1 | Fetch 2 |
|---|---|---|
| `purchase` | `purchase/list` → `k_purchase`, `dt_add`, `s_title` | `purchase/receipt` → **the money** |
| `person` | `staff/list` → `k_staff`, flags | `user?uid=` → email, phone, dob |
| `session` | `classes/list` → `k_class`, capacity | `schedule/class/view` → who taught, times |

Whichever fetch the single column pointed at, the other half of the row had no
provenance — and on `purchase` that half is the money.

`field_group` says which part of the row a fetch supplied, which is what makes the
promise real: if `m_total` is decoded wrongly, the re-parse targets the receipt
rows and leaves `purchase/list` alone.

`table_name` has **no foreign key** — Postgres cannot reference a table named by a
column. Only the writer should insert here, and `0009` ends with a query that lists
any `table_name` which is not a real table.

### Retention is an open decision

These two tables will outgrow every other table combined and hold the most personal
data in the database: names, emails, phones, addresses, dates of birth. Both facts
argue for a policy; neither says what it should be.

The schema provides what a policy needs: `fetched_at` to age on, `processed_at` to
know what is safe to drop, and `on delete cascade` from the raw rows so ageing a
payload out takes its links and leaves the royalty row untouched.

**Worth deciding before the first full backfill.**

## Access control

RLS is enabled on all 18 tables. `service_role` carries `BYPASSRLS`, which is how
the sync writes at all.

`0010` adds five SELECT policies for `authenticated` — `person`, `purchase`,
`purchase_item`, `attendance`, `session` — all keyed off `person.auth_user_id`,
which joins a Supabase auth user to a WL uid.

**RLS enabled with no policies is not a working state.** With RLS on and nothing
granted, `authenticated` sees zero rows including its own — a locked door with no
key. That was the state before `0010`.

No policies on `lead`, `raw_*`, `sync_*` or `staff_pay_rate`. Those are operational
tables and absence of a policy means absence of access.

Proof, not assertion: [`supabase/checks/rls_isolation_test.sql`](../supabase/checks/rls_isolation_test.sql)
inserts two people with different auth ids, fakes each one's JWT the way the API
does, checks each sees only their own rows, and rolls back. Asserting on zero rows
would prove nothing — a policy returning nothing passes "cannot see another user's
data" for the wrong reason.
