# Data model

**38 tables and 19 views** on Supabase — counted from the migrations on 18 Sep 2026.
The number has now drifted twice: it was six tables behind in Aug 2026, and by
Sep 2026 it had gone five tables and three views behind again, `identity`, `student`
and `teacher` included. Counting it is two shell commands over
`supabase/migrations/`; guessing it is how it got wrong both times.

Every design decision below came from calling the live API, and the evidence is
quoted so a future reader can check it rather than trust it.

Structure and module map: [ARCHITECTURE.md](ARCHITECTURE.md).
API findings behind these choices: [WL-API-NOTES.md](WL-API-NOTES.md).

## Layout

```
people      person, lead, identity, student, teacher
                   views: client, active_client, wl_teacher
money       location, service, purchase, purchase_item,
            purchase_payment, purchase_account_credit,
            pay_transaction, pay_transaction_item
                   views: purchase_net, revenue_month, purchase_over_refunded
schedule    session, session_staff, attendance
            cohort, class_session, class_session_teacher
            attendance_record
            cohort_link, session_link, attendance_link
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
| `id` | a `uuid` PRIMARY KEY, defaulted (0034, 0035) |
| `created_at` | when the row first appeared here |
| `updated_at` | when it last **changed** here — maintained by trigger |
| `synced_at` | when it was last **read back** from the source, changed or not |

`updated_at` needs the trigger. A `default now()` fires only at INSERT, so a
column defended by a default alone reports the creation time forever and every
"what changed recently" query is quietly wrong. `synced_at` earns its place by
answering a different question: a sync that finds nothing new moves `synced_at`
and leaves `updated_at` alone, which is how "confirmed unchanged an hour ago"
differs from "nobody has looked at this in a week".

**`id` is the primary key; the natural key is still what an upsert names.**
`0034` added a `uuid id` beside every natural key and deliberately left it as
UNIQUE only. `0035` promoted it to PRIMARY KEY and kept the natural key as a
UNIQUE constraint called `<table>_natkey_unique`. Nothing about the sync
changed, and that is the point: Postgres honours `ON CONFLICT` on **any** UNIQUE
constraint, not only the primary key, so `ON CONFLICT (uid)` still resolves to
UPDATE and a re-sync still never duplicates.

Hold on to the distinction. `id` is plumbing — one uniform handle for foreign
keys, tooling and row-level APIs that do not want to know whether this table is
keyed on one `text` column or three. The source system's key is still the
**identity**, and it is still the conflict target. Keying an upsert on `id`
would mint a new row for a record WellnessLiving has already sent, every run —
which is exactly the failure `0034` was written to avoid, and why it stopped
short of promoting the column it had just added.

## People

```
person (uid PK, k_staff UNIQUE)
   ├── view client       all persons
   ├── view wl_teacher   login_type.is_teacher_type (0014; renamed by 0039)
   └── lead (uid FK, nullable)

identity (one row per human; the only table a WL key may appear on)
   ├── student  (no WL field)
   └── teacher  (no WL field)
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

### `client` and `wl_teacher` are views, not tables

The ticket asked for both separate tables *and* a single row carrying both ids.
Those pull opposite ways; the row won, because that is the requirement with a
reason attached. The views give the names without storing anything twice.

Both use `security_invoker = on`. Without it a view runs with its owner's
privileges and reads straight past RLS on `person`.

`wl_teacher` was called `teacher` until `0039`, which renamed it to free the name
for the portal's own table. It is still the WellnessLiving-shaped projection —
`k_staff`, `is_teaching`, `service_count` — and it is what royalty reporting will
want. The `teacher` **table** is a different thing and holds no WL field at all;
see "The portal's central record" below.

### What identifies a teacher — and what did before `0014`

The live rule is `login_type.is_teacher_type`, which is `k_login_type` **1260510**
("Staff Client Profile"). Everyone else is a student. It is a business rule held as
data, confirmed by the studio 24 Aug 2026 and re-confirmed 17 Sep 2026.

**This paragraph replaces an earlier one that said the opposite.** Until `0014` a
teacher was "a person with a non-null `k_staff`", and the table below recorded why
the login type was *rejected* — a reading that is now three migrations stale and
was still sitting here in Sep 2026, contradicting the view it describes. It is kept
rather than deleted because the measurements are real and the disagreement is the
interesting part:

| Approach | Against `/v1/staff/list` |
|---|---|
| `text_login_type = 'Staff Client Profile'` | 47 clients carry it; only 20 are staff. Over-counts by 27, under-counts by 3 |
| Teaching flags alone | 6 of the 20 staff have no flags and 0 services — finance, admin, operations. They are still staff |
| Present in `/v1/staff/list` | the authoritative list of *staff*, which is not the same question |

Measured against live dev data 24 Aug 2026, the login-type rule and the flag rule
**agree on 15 of 20 people and disagree on five**: Finance Team, Admin
SpinDJAcademy, Pau Leogo and Ian Berk carry the login type with no teaching flag,
and Cameron Escovedo takes appointments under a different type. So the live rule
counts four admin and finance accounts as teachers and omits one person WL says
teaches. The studio was shown this and confirmed the rule anyway.

`is_teaching` is kept on `wl_teacher` precisely so that disagreement stays
queryable. A row where the two differ is somebody being paid who does not teach, or
teaching without being paid, and is worth a human look before it earns a royalty.

All 20 are stored, flags included, so redefining "teaches" is a `WHERE` clause
rather than a migration and a backfill.

### The portal's central record — `identity`, `student`, `teacher` (0039)

`person` cannot describe a student who signed up through the portal, because its
`uid` is WellnessLiving's and is `NOT NULL`. `identity` is the human that can.

```
identity (one row per human, the only table a WL key may appear on)
   ├── uid, k_staff, ghl_contact_id, k_business
   ├── auth_user_id
   ├── student_id ──▶ student   (no WL field)
   └── teacher_id ──▶ teacher   (no WL field)
```

**This is not the design rejected above.** That one was two *unlinked* tables, and
it double-counted the 20 humans who are both staff and clients. Here the hub is the
one row per human and a role is a pointer from it, so the count cannot split. The
rejected design had no hub, which was the whole problem with it.

**The role tables hold no WellnessLiving field.** No `uid`, no `k_staff`, no
`k_login_type`. Every WL key lives on `identity`, which is the mapping table and
the only place one belongs. The portal reads `student` and never learns that
WellnessLiving exists. This is a standing rule for every owned table, not a
property of these two.

**`identity.uid` is nullable and that is the entire point.** A portal-native
student has none and never will until WL is told about them. The FK is
`ON DELETE SET NULL`, not `CASCADE`: this row carries data that has nothing to do
with WL, and losing the WL mirror must never destroy it. After the null, the
identity is simply indistinguishable from a portal-native one — no schedule, no
attendance, no purchases. Nothing in this system deletes anyway; `0027` settled
that deactivated clients stay.

**There is no `uid_detached`, and it was not an oversight.** The first draft of
`0039` carried one: the nulled `uid`, kept so that a human WL later returns
re-links by exact key rather than by a phone-and-email match that can park as
`ambiguous`. It cannot be filled. `ON DELETE SET NULL` nulls the column; a foreign
key cannot copy the value first. Filling it needs a `BEFORE DELETE` trigger on
`person`, and the rule of 17 Sep 2026 is that there is no trigger on delete.

A column that never fills is worse than a missing one: task 030 would read it, find
null, and conclude "no previous uid" when the truth is "never recorded". Dropped by
user decision, 17 Sep 2026. **The cost is that a WL re-link is now always the fuzzy
match** — recorded in task 030, not hidden here. It is affordable only because
nothing in this system deletes a `person`; if that ever changes, this decision is
the first one to revisit.

**`ghl_contact_id` is still not unique**, for the same reason it is not unique on
`person`: a family on one phone number resolves to one contact, and that is
correct.

**One role at a time, as a constraint.** The confirmed rule makes student and
teacher exclusive, so holding both is a bug rather than a case, and
`identity_one_role_check` says so. If a teacher ever enrols as a student, the
change is dropping that one constraint.

Nothing writes these tables from application code. They are maintained by trigger
from `person` — see the migration table in [ARCHITECTURE.md](ARCHITECTURE.md).

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

**A crowded phone asks the email, and that is not the same as choosing.** The
match tries phone first and email second. It used to stop dead when the phone
returned more than one contact, on the reasoning that the person was already
unidentifiable. Live data said otherwise: measured 2 Sep 2026 across six people
sitting as `ambiguous`, the phone returned **2 every time** and the email
returned **exactly 1 for five of them**. The extra contact on each number is a
duplicate record in GoHighLevel — usually the same person again with no email
on it — not a second human. So a crowded phone now falls through to the email,
exactly as an empty one always did, and only an email that is itself
inconclusive leaves the row `ambiguous`.

Nothing about the no-guessing rule moved. A single email match is as strong here
as on the ordinary path, and the shared household address still returns two and
still parks. Re-running the retry after the change took **25 ambiguous rows to
4**, and the four that remain are the ones a human genuinely has to settle: two
siblings sharing one address and one handset, an organisation rather than a
person, and a client whose GoHighLevel contact carries a different address to
the one WellnessLiving holds.

### The GoHighLevel fields and tags are a table, not columns (0026)

`ghl_contact` holds one row **per contact**, and `person` joins it through the
`ghl_contact_id` it already had. No new column on `person`, and no surrogate key.

Three measured reasons, all of which point the same way:

| | |
|---|---|
| `ghl_contact_id` is deliberately non-unique | **307 distinct contacts across 317 matched clients.** A family on one phone shares a contact, so the fields belong to the contact. On `person` the same fact would be stored in N rows, and a partial run can leave them disagreeing — the failure `is_staff` was rejected for |
| Typed tables key on the source system's id | `uid`, `k_purchase`, `k_service`, `k_login_type` are all `text`, and they are what an upsert names. Every base table also carries a `uuid` `id` as its PRIMARY KEY since `0035`, but that is plumbing — the natural key survives as `<table>_natkey_unique` and stays the conflict target |
| A surrogate key would hide a re-key | With the natural key as the conflict target, a re-issued GoHighLevel id shows up as a new row and the old one ages visibly. Upserting on a `uuid` would keep pointing at a contact that no longer exists — which is why `0035` moved the primary key and left the conflict target alone |

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
purchase (k_purchase PK)                    ← per client, from the purchase list
   ├── purchase_item (k_purchase_item PK)   ← THE royalty row
   ├── purchase_payment                     ← a_pay_method, an array
   └── purchase_account_credit              ← a_account_rest, an array

pay_transaction      (row_hash)             ← business-wide, from WL's own reports
pay_transaction_item (row_hash)                (0038; joined on k_purchase /
                                                k_purchase_item, no FK)
```

**Two witnesses to the same money, deliberately not merged.** The `purchase`
side is assembled one client at a time from `/v1/profile/purchase/list` and
`/v1/purchase/receipt`. The `pay_transaction` side is WL's own "All Transactions"
reports, read business-wide in two calls. See "The transaction reports are a
second witness" below for why they are separate tables and what each one can
answer that the other cannot.

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

### The transaction reports are a second witness, not a replacement (0038)

`pay_transaction` (cid 799, one row per payment) and `pay_transaction_item`
(cid 739, one row per paid item) come from `POST /v1/report/query`. They were
added because three things they carry exist nowhere else in this database, and
one thing they do **not** carry is the reason they did not simply replace the
purchase path.

**What they add.**

| Fact | Why it matters |
|---|---|
| `text_revenue_category` — e.g. "Monthly Subscriptions", "Account Payments" | The likeliest grouping a royalty is actually billed on. M04b is blocked on "which items count and how are they grouped"; this is WL's own answer to the second half |
| A refund as its **own dated row** | `purchase.m_refund` carries no date, so a refund lands in the original purchase's month. Here it is a negative row with its own `dtu_date` |
| `s_batch_number`, `text_order_id`, `text_processor_reference`, `o_decline_reason` | Reconciling the studio's processor statement. No other endpoint returns any of them |
| `k_pay_transaction`, `o_actor` | The payment as an event, and who took it ("System" for a recurring charge) |

**What they do not cover, measured 17 Sep 2026.** The item report returns
**10,913 rows for all time** against **20,561 `purchase_item` rows** in this
database. It lists only items a money movement touched — a free item, a comped
one, an unpaid balance, a membership seeded but never charged are all real
purchase items and appear in neither report. So neither table is a superset of
the purchase path, and `purchase.m_refund` stays authoritative for it. **The two
must be reconciled before either is used for a royalty figure, and that
reconciliation is not written.**

### The row identity is a hash, because WL publishes none

Both reports return positional rows and **no unique row key**. Measured over
every row:

| Candidate | Distinct | Rows lost |
|---|---|---|
| 739 `k_purchase_item` | 8,778 | 2,135 |
| 739 `k_purchase_item + k_id + id_table` | 10,656 | 257 |
| 739 …`+ dtu_date + m_amount` | 10,882 | 31 |
| 799 `k_pay_transaction` | 9,419 | 777 |
| 799 `k_pay_transaction + i_row_order + dtu_date` | 9,547 | 649 |

And `k_pay_transaction` is **null on 10,838 of the 10,913** item-view rows — the
column naming the transaction is absent from the report named after it.

The "duplicates" were checked rather than assumed, and they are **a sale row and
its later refund row**: same item key, opposite sign, different date. Both are
real events, so every key above is wrong by construction.

So identity is `row_hash` — sha256 over exactly the values stored, in a fixed
order — plus `i_occurrence`, which numbers rows whose stored values are
identical. The hash covers the stored subset and **not** the whole row because
the whole row carries signed `url` tokens and tooltip HTML that change between
builds; hashing those would give the same transaction a new identity and insert
a second copy on every run.

`item_title` is in the hash for a measured reason: twelve repeat groups in the
item report differ in nothing else ("General credit" against "Account Payment"
on the same item key, date and amount).

**The one limit, stated plainly.** `i_occurrence` is counted within one read of
one window, so an interrupted page read restarts the count and can merge two
byte-identical rows. It can undercount a repeat, never double-count one. 649
rows of the payment report are byte-identical to another row across all 140
fields, so this is not hypothetical — it is the price of not collapsing them.

### `k_purchase` here is not a foreign key, on purpose

The reports reach transactions whose purchase the per-client path has never
listed. A FK would need a `purchase` stub with no totals, and an unpriced
purchase row enters `purchase_net` and understates a month while looking clean.
`uid_client` and `k_location` DO have FKs, filled by stub-upsert first — the same
stub-don't-fail pattern purchases.ts uses, where a stub is the key and the
business only so a later profile sync fills the rest.

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

### The portal's schedule — `cohort`, `class_session` (0041, 0042)

Everything above is the WellnessLiving mirror. The portal does not read it. It
reads `cohort` and `class_session`, which carry **no WellnessLiving field at
all**, with `cohort_link` and `session_link` carrying nothing else.

```
session.k_class          ──▶ cohort_link   ──▶ cohort         (no WL field)
session (k_period, dt)   ──▶ session_link  ──▶ class_session  (no WL field)
session_staff                                   └── class_session_teacher
```

**WellnessLiving compresses two levels into one table, and the portal needs
both.** `0004` states it: `k_class` 268302 is "A Joyful Noise | 60 Minutes" every
week forever, so it names the *class*, not the occurrence. But `k_class` is a
**column on `session`** — there is no class table. `cohort` is that missing level,
which is also why `cohort_link` carries no foreign key: nothing is unique on
`session.k_class` for it to reference. `session_link` does have one, because
`session` is a real table with a real key.

**Presence of a link is the provenance.** A `class_session` with a `session_link`
row came from WellnessLiving; one without was created in the portal. Nothing else
records it, so nothing can disagree — the same reasoning `0001` used when it
refused an `is_staff` flag in favour of "a non-null `k_staff` is the answer". A
`source` column would be a second place holding one fact.

**An unnamed class still shows.** A session may carry a `k_class` nobody has
mapped. `0042` stubs a cohort from the session title with `is_resolved = false`
rather than hiding the session, because the requirement this work exists for is
that a session visible in WellnessLiving is visible in the portal. The flag keeps
a placeholder countable instead of indistinguishable from a name a human chose —
the same shape as `service.is_resolved` in `0012`.

**Teachers are a join table, not a column.** `class_session_teacher` exists for
exactly the reason `session_staff` does one level down: WL allows several staff on
an occurrence and flags substitutes, and the substitute is who a royalty is owed
to. The dashboard shows one name; that is a choice the API makes from complete
data, not one the schema makes for it. It needs no link table — the occurrence
resolves through `session_link` and the person through `identity`.

**A teacher recognised late is still attached.** `0042` has a fourth trigger, on
`identity.teacher_id`. Without it, any session taught by someone whose role was
not yet known — a stub person, the ordinary state — would show no teacher for
ever: the staff row is never rewritten when the person is later enriched, so
nothing would call the projection again.

**The `WHEN` clauses list projected columns one by one.** `old.* IS DISTINCT FROM
new.*` would have been shorter and would fire on every session every night,
because `session.synced_at` moves on every pass whether or not anything changed.

**Local time is copied, never re-derived** — `local_start` is `timestamp` without
a zone, matching `dtl_start_local`. The reasoning is the same one recorded above
for `session`: WL's `text_timezone` is `"ET"`, an abbreviation that does not say
whether EST or EDT was in force.

### `attendance_record` — and why it has a link after all (0043, 0044)

An earlier draft of this design argued that attendance needed no link table: its
WL key `(k_period, dt_start_utc, uid)` is already resolvable, the occurrence
through `session_link` and the person through `identity`. That is true **for
mapping**, and it was the wrong conclusion, because mapping is not the only thing
a link carries.

The question the design has to answer is **where did this attendance come from** —
WellnessLiving, or the portal? Nothing in `(class_session_id, student_id)` can
say. And the two sources are real rather than hypothetical: a portal-native
student has no `uid`, so WellnessLiving cannot ever report their attendance.

> A link row means WellnessLiving sent it. No link row means the portal did.

Provenance is therefore **derived, never stored**. A `source` column would be a
second place holding a fact the link already holds — the thing `0001` refused when
it rejected an `is_staff` flag. The link buys a third thing neither mapping nor a
column would: if a session is marked attended in the portal and WL later syncs the
same attendance, **that collision is visible** instead of silently overwritten.

**The backfill is set-based, and that is a deliberate departure.** `0040` and
`0042` loop row by row, which was fast enough at 1,285 people and 44,499 sessions.
This is the largest table here — one row per attendee per occurrence, for ever —
and a loop over it in the SQL editor is a statement timeout, not a slow success. A
backfill that dies half way leaves exactly the silent gap the one-file rule exists
to prevent.

**Attendance by a teacher is not projected, and that is the role rule showing
through.** `attendance_record.student_id` is `NOT NULL`, and a person is a student
or a teacher, never both. A staff member who attends a class as a client is
visible in the WL mirror and absent from the portal's view. It is written here so
it is recognised rather than rediscovered.

**`is_attended` is nullable here too, and the first draft of `0043` got that
wrong.** It was written `not null default false` — exactly what `attendance` used
to be, and exactly what `0029` removed. That reasoning transfers word for word:
the default asserts every visit was *not* attended until proven otherwise, which
is a claim nobody can make about a session that has not happened yet, or one WL
has left PENDING for staff to settle.

A not-null violation on the backfill is what caught it. The tempting fix was
`coalesce(is_attended, false)`, and it would have been **worse than the error** —
it turns "we have no idea" into "they did not turn up", silently, in the column a
student reads as their own record and a royalty is calculated from.

**A person who becomes a student keeps their history.** `0044`'s third trigger
fires on `identity.student_id`. Without it every class a stub person had already
attended would be missing for ever: the attendance rows are never rewritten when
the person is later enriched, so nothing would call the projection again. It is
the same hole `0042` closes for teachers, one table along.

## Staff pay — structure only

`staff_pay_rate` and `staff_service` exist, but `m_rate` is **null and will stay
null** until rates arrive from somewhere other than the API.

WL returns pay rate **keys**, never amounts:

```json
a_pay_rate      = ["310039", "308721"]
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
