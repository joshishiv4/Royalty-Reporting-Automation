# Data model

26 tables and 16 views on Supabase — counted from a database with every migration
applied, 27 Aug 2026, because the number here had drifted six tables behind. Every
design decision below came from calling the live API, and the evidence is quoted so
a future reader can check it rather than trust it.

Structure and module map: [ARCHITECTURE.md](ARCHITECTURE.md).
API findings behind these choices: [WL-API-NOTES.md](WL-API-NOTES.md).

## Layout

```
people      person, lead                     views: client, active_client, teacher
money       location, service, purchase, purchase_item,
            purchase_payment, purchase_account_credit
                   views: purchase_net, revenue_month, purchase_over_refunded
schedule    session, session_staff, attendance
                   view: session_outcome
staff pay   staff_pay_rate, staff_service
reference   promotion, shop_category, service_category, login_type
                   view: unresolved_service
ghl         ghl_contact, ghl_custom_field
                   views: client_ghl, ghl_enrichment_missing
control     sync_queue, sync_job_state, sync_run, sync_conflict
                   views: sync_queue_progress, ghl_match_progress
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

### `is_active` is the only status WL will give us (0027)

The database stores **every** client — 1,285 across all statuses, not just the 517
the portal calls "Activated" — because a cancelled client a purchase still points
at has to resolve. `is_active` says which of them WL currently activates.

It is a **boolean, and derived from a set, not read from a field**. The client-list
report row carries a client *type* label (`text_client_type` → `text_login_type`)
but **no status column**. And the report's `o_member_status` filter distinguishes
exactly one value: measured 26 Aug 2026, `[3]` returns the 517 activated, while
`[1]` and `[2]` are ignored and return all 1,285. So "activated" is the only status
the API can actually tell us — `is_active` is set by whether a uid appears in the
`[3]` result, and everyone else is false.

**Type is not status.** "Inactive Client" and "SDC Client" both appear among the
activated 517 *and* among the deactivated remainder, so deriving activation from the
type label would misclassify thousands. Null means the person reached the table as a
purchase-only stub and the client-list report has not yet covered them.

### `lead`

A lead has no `uid` — it is a form submission, not an account. When it converts,
WL creates a client of type "Prospect" (`k_login_type` 1234074) and `uid` is
filled in, which is why it is a nullable column rather than a second table.

**It cannot be populated from the API today.** `/v1/lead/info` returns the form
*definition* only, and no endpoint lists leads. The form is business-configurable
— observed 4 fields keyed 299334/299335/299332/299336 — so `k_field_map` records
which key supplied which value.

### The GoHighLevel link

Four columns on `person`, and three of them exist because one was not enough.

| Column | Answers |
|---|---|
| `ghl_contact_id` | which contact, once resolved |
| `ghl_match_state` | `matched` / `ambiguous` / `unmatched` / `failed` |
| `ghl_match_attempted_at` | when we last looked |
| `ghl_unresolved_since` | since when this client has had no usable link |

`ghl_contact_id` is **deliberately not unique**. A family on one phone number
resolves several clients to the same contact: the phone search returns one
contact, so every member matches it. That is a correct result, not a collision,
and it is flagged nowhere. A unique index here would look like tidying up and
would silently break it.

The two timestamps are not redundant. `ghl_match_attempted_at` is what the
automatic pass reads — a null there means nobody has ever searched for this
client, which is the only thing that pass picks up, so a matched client cannot be
re-queried even by the weekly full refresh. But it is rewritten by every retry,
so it cannot answer "how long has this been sitting unresolved". Building the
48-hour alert on it would produce an alert that can never fire: a record
ambiguous for a month reads as two minutes old the moment somebody re-runs the
retry pass, which is worse than no alert because it reports safety.

`ghl_unresolved_since` is set on the first non-matching outcome, left alone by
every later attempt, and cleared only by an actual match. The three GoHighLevel
rows in `data_health_issue` date from it rather than `synced_at` — `synced_at`
moves on every WL sync, so `data_health.oldest` had never meant what its name
said for those rows.

`unmatched` is not an error. The person is simply not in GoHighLevel; the client
record stays complete and fully usable with the link empty, and **nothing is
created in GoHighLevel to fill the gap** — which is why `matched` always means a
contact that already existed. `ambiguous` is never auto-resolved: choosing
between candidates would put one person's royalties on another person's record.

### The GoHighLevel fields and tags are a table, not columns (0026)

`ghl_contact` holds one row **per contact**, and `person` joins it through the
`ghl_contact_id` it already had. No new column on `person`, and no surrogate key.

Three measured reasons, all of which point the same way:

| | |
|---|---|
| `ghl_contact_id` is deliberately non-unique | **307 distinct contacts across 317 matched clients.** A family on one phone shares a contact, so the fields belong to the contact. On `person` the same fact would be stored in N rows, and a partial run can leave them disagreeing — the failure `is_staff` was rejected for |
| Typed tables key on the source system's id | `uid`, `k_purchase`, `k_service`, `k_login_type` are all `text`. A `uuid` PK appears only where the source gives no key: `lead`, `raw_wl`, `raw_ghl`, `raw_link`, `sync_*` |
| A surrogate key would hide a re-key | With the natural key, a re-issued GoHighLevel id shows up as a new row and the old one ages visibly. A `uuid` would keep pointing at a contact that no longer exists |

**The agreed field list is data, not schema — and that is what unblocked M06.**
The ticket sat open because "the agreed fields" was being modelled as columns, so
nothing could be built before the list arrived and everything would need
migrating again if it changed. Instead `ghl_contact.fields` keeps **every**
custom field the contact carried, and `ghl_custom_field.is_reported` says which
may be shown. `client_ghl` projects only those. Confirming the list is an
`UPDATE`; so is changing it.

`is_reported` defaults to false. Nothing reaches a client record until somebody
says it should — a half-right field on a client record gets believed.

**Field names are unavailable, not omitted.** The contact response carries field
**ids** only; `GET /locations/{id}/customFields` maps them to names and answers
**401** for a contacts-scope Private Integration Token. So
`ghl_custom_field.name` is nullable and arrives from the client or from a widened
token — never from a guess. Measured 26 Aug 2026: exactly three field ids exist
in this location's data, and 254 of 325 contacts carry an empty `customFields`
array.

**Tags replace, they do not merge.** 44 distinct tags observed, 1–11 per contact.
Many are operational state GoHighLevel retires — `mal inbox`, `nl stage 2`,
`power dialer clean up`. Merging would keep a tag after GoHighLevel removed it,
with nothing able to take it off again. Every fetch is kept in `raw_ghl`, so
replacing is reversible rather than lossy.

**Fetched once, never refreshed.** A client is searched exactly once; the
enrichment is parsed out of that same response, so it costs no extra API call.
`fetched_at` is therefore the date of the match, not of the data, and a tag
changed in GoHighLevel afterwards is not reflected. `stale_ghl_contact` reports
that age past `ghl_stale_after()` (30 days) — deliberately, and knowing it will
not clear while nothing refreshes. It states an age for a reader to weigh, not a
fault to chase. `missing_ghl_enrichment` is the companion that **does** clear:
linked with nothing stored, closable by re-parsing `raw_ghl` with no API call.

**RLS on, no policy.** The tag set includes `disqualified lead`, `bad email` and
`no phone number` — the studio's notes about a client, not the client's to read.
Reporting runs on the service role.

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

### The refund is a fact about the purchase, not the item (0028)

`purchase.m_refund` is authoritative. `purchase_item.m_refund` still exists and
records what arrived, but **nothing may SUM it** — and this is not a style rule,
it was misstating revenue by five figures.

WL reports `m_refund` on `/purchase/list/element`, which is called **per item**.
Every item of a refunded purchase therefore comes back carrying the *same*
refund, and storing it per item made a sum multiply it by the item count:

```
purchase 174396118   m_total $475.00   5 items x -$380.00 = -$1,900.00   (4x)
purchase 174398437   m_total $285.00   3 items x -$190.00 =   -$570.00   (2x)
```

Measured 27 Aug 2026 across 381 refunded purchases. **52 have more than one
refunding item and all 52 carry an identical amount on every one** — not a single
case of two items differing. The test that settles it is "refund exceeds the
purchase total", which should be nearly impossible:

| | Purchases | Excess |
|---|---|---|
| Summing over items | 38 | $17,303.50 |
| **One per purchase** | **3** | **$63.50** |

A 273× reduction in the anomaly.

**Net revenue is `m_total + m_refund` on `purchase`** — adding, because the sign
is already negative. Read `purchase_net` or `revenue_month` and the convention is
applied once instead of per report.

Two limits worth knowing, neither fixable from what WL sends: `m_refund` carries
**no date**, so a refund lands in the original purchase's month (`dt_cancel` is a
separate fact); and `purchase.dt_add` is UTC with no local twin, so month
boundaries are UTC.

An **unpriced** purchase contributes `null`, never `0`. `purchase_net.is_priced`
says which, because counting an unread receipt as a $0 sale understates a month
without looking wrong.

### Active is a status, and the type label is not it (0027, 0028)

`person.is_active` — 517 of 1,285 clients, which agrees exactly with what the WL
portal's "All Clients" report calls Activated (measured 27 Aug 2026). Read
`active_client` for them.

**Do not filter on `text_login_type`.** Nine types appear *both* active and
inactive:

| Type | Active | Not |
|---|---|---|
| Cancelled Client | **55** | 658 |
| Inactive Client | **60** | 27 |
| SDC Client | 200 | 7 |
| Staff Client Profile | 25 | 22 |
| Prospect | 13 | 17 |

"Cancelled Client" holding 55 **active** clients is the whole point: the type is
what the studio filed them under, not whether WL activates them today.

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

### What happened is `id_visit`, not `is_checkin` (0029)

`attendance.id_visit` carries WellnessLiving's own verdict, and everything else
about the outcome is derived from it.

`is_attended` used to be written from `session.is_checkin`. The API documents
`is_checkin` as *"ready to be checked in"* / *"can't be checked in"* — whether the
check-in button is live, not whether anybody walked in. Measured 27 Aug 2026:

| | |
|---|---|
| `session.is_checkin = true` | **0** of 4,423 |
| `attendance.is_attended = true` | 4 of 4,431 |
| `is_cancelled_client` / `is_cancelled_studio` | 0 / 0 |
| `session_outcome` | 988 upcoming, 12 unknown, **0 countable** |

So the royalty attendance signal was not merely wrong, it was **empty**.

`WlVisitSid`, from `/v1/schedule/page/element`:

| Code | Meaning | `is_attended` | Other |
|---|---|---|---|
| 1 BOOK | reserved, not yet | **null** | |
| 2 WAIT | wait list | **null** | |
| 3 ATTEND | attended | true | **the only countable one** |
| 4 PENALTY | cancelled too late | false | `is_cancelled_client` + `is_late_cancel` |
| 5 TRUANCY | missed, no cancellation | false | `is_no_show` |
| 6 CANCEL | cancelled in time | false | `is_cancelled_client` |
| 7 PENDING | staff must decide | **null** | `visit_awaiting_staff` |
| 8 REMOVE | hidden in WL | **null** | |

**`is_attended` is nullable on purpose.** `not null default false` claimed every
visit was un-attended until proven otherwise — in the column royalty is paid
from. Null now means "not known yet"; false means WL said they did not turn up.

**Two things the docs got wrong, both measured:**

- The enum is linked as `Wl/Visit/VisitSid.php`, which **does not exist**. It is
  `Wl/Visit/WlVisitSid.php` — which is why the constants were unreachable and the
  field went unread.
- ~~`id_visit` is documented at the top level but real payloads nest it.~~
  **Our error, not theirs.** Measured over 200 stored `page/element` payloads:
  `id_visit` is present at the **top level and** inside
  `a_appointment_visit_info`, 200 of 200 each. The code reads nested first and
  falls back, which is correct either way. Only the first defect above is real.

**A cancellation timestamp is not on `/v1/schedule/page/element`.** Measured over
200 stored payloads (27 Aug 2026): the only date-bearing key matching `cancel` is
`dt_cancel`, the cancel-by deadline, stored as `dt_cancel_by` (0017).

It **does** exist elsewhere in the API, on endpoints this project does not call
yet — this section used to say "nowhere in the 208-path spec", which was wrong.
`dt_date_cancel` sits on the StaffApp schedule list but is **session-level**, so
it does not say whether the client dropped their place or the studio pulled the
appointment. `Profile/Activity` is a per-client timestamped log whose
`WlLoginActivityTypeSid` names `CLASS_CANCEL` and `APPOINTMENT_CANCEL` as client
acts. Neither is measured, and the activity log's `k_id` is a class period, which
repeats weekly — so it identifies the class, not the occurrence. See
[WL-API-NOTES.md](WL-API-NOTES.md).

So today: "was it cancelled, and was it late" is answerable from `id_visit`; "at
what moment" is not stored, and is no longer known to be unavailable.

**The check-in MOMENT does exist, and it is not `is_checkin`** (0030).
`attendance/list` returns `dt_register` — *"the date the client checked in for the
visit, in UTC"* — on 55 of 55 sampled client records, and it was being discarded.
Stored as `dt_checkin_utc`. It is **evidence beside the verdict, not a second
verdict**: nothing derives from it and no view gates on it, because `id_visit` is
the authority. Its nulls are the useful part — a studio that does not use check-in
produces nulls on sessions that happened, which is how Q9 gets answered by
counting rather than by asking.

**Two writers, one row.** `attendance` is written by both
[`client-sessions.ts`](../src/sync/client-sessions.ts) (per client, from
`page/element`) and [`attendance.ts`](../src/sync/attendance.ts) (per class
occurrence, from `attendance/list`), on the same primary key. Both upsert the
outcome unconditionally, so the later pass wins regardless of which payload is
fresher. Measured 31 Aug 2026: the two routes overlap on 5 (visit, client) pairs
and **disagree on 0**, so this is a structural risk rather than an active fault —
recorded because the day they disagree, nothing in the code decides who is right.
The derivation itself cannot diverge: both import
[`visit-outcome.ts`](../src/sync/visit-outcome.ts).

**Open decision — is a late cancellation royalty-bearing?** `is_late_cancel`'s
comment (0004) says such a cancellation is "usually still billable", but billable
to the *client* is not the same as royalty-bearing to the *teacher*.
`is_countable` currently says no, and `is_late_cancel` is exposed on
`session_outcome` so the decision can be made in a `WHERE` clause rather than
assumed in the view.

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
sessions, and attendance now populates - the blocker was our own parameter
name (see [STATUS.md](STATUS.md)).

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
