# WellnessLiving and GoHighLevel API notes

Everything here was measured against the live UAT host on **19 Aug 2026**, not read
from documentation. Where the docs and the API disagree, the API is recorded and the
disagreement is called out.

Keep this updated when something new is discovered — several of these cost hours to
find and none of them are written down anywhere else.

## WellnessLiving

### Auth

Two different hosts. This trips people up.

| | Host | Used for |
|---|---|---|
| `WL_AUTH_HOST` | `access.api.…` | `/oauth2/token` only |
| `WL_API_HOST` | `api.…` | every data endpoint |

`client_credentials`, form-encoded. Tokens last an hour; the client refreshes at 55
minutes. No `id_region` or `k_business` on the token call — business scoping is
meaningless before there is a token.

### Success is in the body, not the status code

**This is the single most important thing about this API.** WL answers HTTP 200 for
errors:

```json
{
  "status": "id-empty",
  "a_error": [{ "sid": "id-empty", "s_message": "No ID is specified.",
                "s_field": "k_purchase_item" }]
}
```

`status === "ok"` is the only success. Anything else is a failure carried on a 200.
Trusting the status code writes empty rows and reports success.

`a_error[].sid` classifies it. Bad-parameter errors never succeed and should not
burn retries.

### Dates need a time component

```
dt_date=2026-08-19             ->  dt-date-invalid
dt_date=2026-08-19 00:00:00    ->  ok
```

A silent trap: the short form looks reasonable and fails with a message that does
not say why.

### `dt_` is UTC, `dtl_` is local

Confirmed on one purchase — `dt_add` `"2023-07-03 17:12:31"` against
`dtl_purchase` `"2023-07-03 13:12:31"`, exactly four hours apart.

**But `text_timezone` is `"ET"`** — an abbreviation, not an IANA name. It does not
say whether EST or EDT applied, so a local time cannot be reconstructed from the UTC
value alone. Store `dtl_` where local wall time matters.

### List endpoints return KEYED OBJECTS, not arrays

```json
"a_staff": { "343509": { … }, "344486": { … } }
```

The object key is the record key. Iterate with `Object.values()`; `.length` is
`undefined` and `.map` does not exist.

### `k_log` — WL's trace id — is mostly absent

| Endpoint | `k_log` |
|---|---|
| `/v1/business` | absent |
| `/v1/location/list` | absent |
| `/v1/staff/list` | absent |
| `/v1/user` | absent |
| `/v1/profile/purchase/list` | absent |
| `/v1/lead/info` | **present** — `"[31.77ldu]"` |
| a real error envelope | `"0"` — a placeholder |

WL's own Postman collection documents it on four endpoints with values like
`"[42.wiyy6]"`, so it is not switched off account-wide; it is per endpoint.

`"0"` is filtered out. Storing it is worse than storing nothing — it sends support
hunting a log entry that never existed. On errors it hides at
`a_error[0].a_message_source["[k_log]"]`, brackets included.

Because none of this can be relied on, the service generates its own trace id.

### Rate limits are undocumented and were never hit

Nothing in the Postman collection mentions a rate limit, throttling, 429 or quota.
Over 100 unthrottled probe calls in one session never triggered one.

The 5 req/s cap this project used to impose was **ours**, not WL's, and has been
removed. The backoff and requeue machinery remains for when WL does push back.

**Ask WL** what the real limits are before assuming a number.

### Working endpoints

| Data | Endpoint | Required params |
|---|---|---|
| Business | `/v1/business` | — |
| Locations | `/v1/location/list` | — |
| Staff | `/v1/staff/list` | — |
| Client detail | `/v1/user` | `uid` |
| Client search | `/v1/login/search/staff-app/list` | `text_search` |
| Client types | `/v1/login/type` | — |
| Purchases | `/v1/profile/purchase/list` | `uid` |
| **Money** | `/v1/purchase/receipt` | `uid`, `k_purchase` |
| Class definitions | `/v1/classes/list` | `k_location` |
| **Session + who taught** | `/v1/schedule/class/view` | `k_class_period`, `dt_date` |
| Client visits | `/v1/schedule/page/list` | `uid` |
| Calendar days | `/v1/schedule/class/list` | `k_location`, `dt_date` |
| Promotions | `/v1/classes/promotion` | `k_location` |
| Shop categories | `/v1/shop/category` | — |
| Service catalogue | `/v1/appointment/book/service/list` | `k_location` |
| Service categories | `/v1/appointment/book/service/category` | `k_location` |
| Lead form definition | `/v1/lead/info` | — |

All GET unless noted. `id_region` and `k_business` are added by the client.

### Endpoints that do not work

| Endpoint | Result | Meaning |
|---|---|---|
| `/v1/collector/debt/list` | `subscription-access` | not on this plan |
| `/v1/collector/debt/transaction` | `subscription-access` | not on this plan |
| `/v1/login/attendance/list` (APPOINTMENT k_period) | `id-nx` | **classes only** — see §"attendance is class-only" below |
| `/v1/report/query` | `method-nx` on GET | POST only |
| `/v1/report/data` | `report-nx` | needs a report sid |
| `POST` on most read endpoints | `method-nx` | GET only |

### Three open questions for the WL integrations team

**1. Is there any endpoint that lists clients? — likely the report, but we need its CID.**
`/v1/login/search/staff-app/list` requires a search term — `{}` returns 6 rows,
`"a"` returns 17 — so it cannot enumerate. The candidate path is the **report**:
`/v1/report/query` (probed live 21 Aug 2026) is **POST** and requires a
`cid_report` — a specific positive integer naming which report. Guessed CIDs
(1/10/100/439) all return `cid-nx` ("does not exist"), so the CIDs are not
sequential and cannot be discovered by probing.
**What we need from WL / the WL admin UI:** the `cid_report` of the client report
(its export URL / config usually shows it). With that CID, `report/query` should
return the client list (paged, read via `/v1/report/data` by a handle) — the
foundation for P5 tasks 017–019. Until then `person` fills from the 20 staff only.
**This is the main blocker on a full sync.**

**2. How is a `k_staff_pay` resolved to an amount?**
`/v1/staff/list` returns `a_pay_rate` as keys only — `["310036","308721"]` — and
`a_staff_service` as `{"k_service":"142047","k_staff_pay":"310041"}`. None of the 75
endpoints in the collection resolves a key to a rate. Without this there is no
teacher cost and no margin.

**3. What are the correct parameters for `/v1/login/attendance/list`?** ✅ resolved
The parameters are `dt_date_local` (LOCAL time, `YYYY-MM-DD HH:MM:SS`) and
`k_class_period` — confirmed against the live Postman collection and
apidoc.wellnessliving.io. The earlier `date-incorrect` was a wrong-key test; the
key `dt_date` is not used — only `dt_date_local`.

### `/v1/schedule/page/list` is NOT future-only — `is_past` was never sent

Measured 27 Aug 2026. This corrects a claim that sat in the code for weeks and
blocked the historical load.

The sync sent only `{ uid }`, and in that shape the endpoint answers with
**upcoming** visits. It also accepts `is_past`, and date bounds named
**`dtu_start` / `dtu_end`** — not `dt_`, which is why an earlier probe concluded
the dates were ignored.

One uid, one endpoint, same session:

| Query | Visits | Range |
|---|---|---|
| `{ uid }` | **0** | — |
| `{ uid, is_past: 1 }` | **402** | 2021-01-30 .. 2025-02-20 |
| `{ uid, dtu_start, dtu_end }` (2025) | 0 | no `is_past`, so still the future list |
| `{ uid, is_past, dtu_start, dtu_end }` (2025) | 3 | the window **narrows** |
| `{ uid, is_past, 1990 .. 2030 }` | **402** | identical — widening changes nothing |

**`is_past=1` alone returns the client's complete past.** 402 is not a page and
not a cap; widening the window to 1990–2030 returned the same rows over the same
range, and the earliest visit did not move. So a historical backfill needs **no
date paging** — one call per client.

The list returns pointers only (`k_visit`, `dtu_date`, `id_visit`, `k_business`);
appointment-vs-class is decided by `/v1/schedule/page/element`, exactly as the
ongoing pass already does. So the existing two-step pipeline works unchanged.

**Scale, sampled over ten clients:** 10.6 past visits each and half with none —
about 13,600 element calls for all 1,285 clients, under an hour at 5 req/s.

### Q8 — a business-wide session list exists in the platform, path unknown

The OpenAPI spec (`openapi-20241224.yaml`, 208 paths) names
`Wl/Schedule/ScheduleList/StaffApp/ScheduleListModel`:

> "Gets information about sessions (both classes and appointments) at a business
> on a given day"

with `dl_start` / `dl_end` for a range, or `dt_date` for one day, plus
`k_business`. That is exactly what Q8 asks for, so the capability is real.

**But the REST path is not published.** The spec lists PHP model names, not `/v1`
paths, and four guesses all returned HTTP 404:
`/v1/schedule/schedule-list/staff-app/list`, `/v1/schedule/staff-app/list`,
`/v1/schedule/list/staff-app/list`, `/v1/schedule/schedule/staff-app/list`.

**What to ask WL:** the `/v1` path for `ScheduleList/StaffApp/ScheduleListModel`.
It would cut the per-client fan-out to one call per day. Lower priority than it
was, though — `is_past` already makes the per-client route cheap.

### `id_visit` is the outcome — and the docs hide it twice

Measured 27 Aug 2026. `/v1/schedule/page/element` returns `id_visit`, documented
as *"the status of the visit"*, one of the `WlVisitSid` constants:

| Code | Constant | Docs say |
|---|---|---|
| 1 | BOOK | Active reservation — the client is going to attend |
| 2 | WAIT | On the wait list |
| 3 | ATTEND | Client has attended the session |
| 4 | PENALTY | Client has cancelled his reservation **too late** |
| 5 | TRUANCY | Client has missed the session **without cancellation** |
| 6 | CANCEL | Client has cancelled **in time and without penalty** |
| 7 | PENDING | Registered, but ATTEND/TRUANCY/PENALTY undecided — *"must be set manually by staff"* |
| 8 | REMOVE | Removed; hidden everywhere in WL but kept in their database |

**So a cancellation IS reported**, and a late one is told apart from a timely
one. Two doc defects hid it:

1. The enum is linked as `Wl/Visit/VisitSid.php`. **That file does not exist** —
   it is `Wl/Visit/WlVisitSid.php`. Every attempt to read the constants 404s, so
   the field list says "one of the VisitSid constants" and the constants are
   unreachable.
2. `id_visit` is documented at the **top level** of the response, and the first
   payloads read were parsed from `a_appointment_visit_info`, so the note here
   used to say the docs were wrong about the location. **They are not.** Measured
   over 200 stored `page/element` payloads on 27 Aug 2026, `id_visit` is present
   in **both** places, 200 of 200 each. The code reads nested first and falls
   back to top level, which is correct either way — but "the docs put it in the
   wrong place" was our error, not theirs.

**`is_checkin` is not attendance.** Docs: *"If true, then this visit is ready to
be checked in. If false, then this visit can't be checked in."* It was true on
**0 of 4,423** sessions, so reading it as attendance left the royalty signal
empty.

**`dt_cancel` is the cancel-by deadline, and now the docs say so in words.**
*"The latest date and time for when the visit can be canceled without penalty."*
That matches the earlier measurement of 24h before start on 40 of 40 visits
exactly. Re-measured 27 Aug 2026 over 200 stored `page/element` payloads: the
only key matching `/cancel/i` with a date in it is `dt_cancel`, every value in
the future, one distinct value per occurrence. `is_enable_client_cancel` is true
on 200 of 200 and is a **permission**, not an event.

### A cancellation timestamp DOES exist — twice — just not where we looked

This section used to say *"no cancellation timestamp exists anywhere in the
208-path spec"*. **That was wrong**, and it was wrong because the search stopped
at the endpoints this project already calls. Reviewed against the published
OpenAPI spec on 27 Aug 2026:

**1. `dt_date_cancel`** — *"The date/time when the session was canceled in UTC.
Only used for appointments."* It is on
`Schedule/ScheduleList/StaffApp/ScheduleList{,ByToken}Model` — the same StaffApp
endpoint recorded below as "the REST path is not published". So the field was
one unreachable endpoint away, not absent.

Read it carefully before trusting it: it is **session-level**, and the naming
trap applies. "The session was canceled" does not say whether the client dropped
their place or the studio pulled the appointment. For a 1:1 appointment those
collapse to the same row, which is exactly how a studio cancellation would end
up on a student's record. **Unmeasured — do not populate a client-cancellation
column from it without proving which event it records.**

**2. `Profile/Activity/{List,Element}Model`** — a per-client, timestamped event
log, and the one route that is unambiguous about who acted:

| Field | Meaning |
|---|---|
| `dt_date_gmt` / `dt_date_local` | when the activity happened |
| `id_type` | one of `WlLoginActivityTypeSid` |
| `k_id` | *"Object ID, for example, class period ID for books and visits"* |
| `html_message` / `s_message` | *"Description of the action, who and what did"* |

The constants say plainly what the visit statuses only imply:

| Constant | Value | Docs say |
|---|---|---|
| `CLASS_CANCEL` | 3 | **"Client cancelled a class."** |
| `APPOINTMENT_CANCEL` | 28 | **"Client cancels an appointment."** |
| `ENROLLMENT_CANCEL` | 18 | Client cancels an enrolment |
| `CLASS_VISIT` / `APPOINTMENT_VISIT` | 15 / 23 | Client attends |
| `CLASS_BOOK` / `APPOINTMENT_BOOK` | 2 / 27 | Client books |

**The same file-name defect hides these too.** The spec links the enum as
`RsLoginActivityTypeSid` — **404**. It is `Wl/Login/WlLoginActivityTypeSid.php`.
That is the second time an unreadable link hid the field that answers the
question; `VisitSid` → `WlVisitSid` was the first. **When a constants link 404s,
try the `Wl`-prefixed name before concluding the data is not published.**

Three costs to weigh before building on route 2, none of them measured yet:

- **N+1.** The list returns *"each activity as an ID number"* and nothing else,
  so every activity needs its own `element` call.
- **No date filter.** `List` takes only `k_business` and `uid`. There is no
  window to narrow, which is the shape `selectAll` exists to defend against.
- **`k_id` cannot identify an occurrence.** It is a class period, and a class
  period **repeats weekly** (see the `k_class_period` trap below). Two
  cancellations of the same weekly class produce two rows with the same `k_id`,
  and the timestamp on the row is when the client *cancelled*, not when the
  session *was*. Pinning an activity to one occurrence needs the booking, not
  just this log.

### The spec is a floor, not a contract

Two reasons to keep measuring rather than reading:

**It is dated.** The published file is `openapi-20241224.yaml` — December 2024,
roughly twenty months stale as of August 2026.

**It under-reports.** Live `attendance/list` records carry `is_visit`,
`is_truancy`, `is_penalty`, `is_pending`, `url-cancel` and `url-cancel-admin`;
**none of those appear in the spec at all**. So the spec listing a field is
weak evidence it exists, and the spec omitting one is no evidence it does not.

### Why four `/v1` path guesses all 404'd — the scheme was wrong, not the words

`WlModelAbstract::resource()` in the public SDK builds its URL from the class
name and nothing else:

```
namespace path after WellnessLiving\  +  class name minus the `Model` suffix  +  '.json'
```

PascalCase is **preserved**, and there is no `/v1`. So the SDK addresses
`Wl/Schedule/ScheduleList/StaffApp/ScheduleList.json`, while this project talks
to lowercase `/v1/...` paths that work fine. **Two addressing schemes exist for
the same models.** Every guess recorded below was a guess inside the scheme that
does not contain that endpoint, which is why all four failed the same way.

Worth trying before asking WL anything: the SDK scheme is derived, not guessed.

The StaffApp schedule list is worth reaching for three fields beyond
`dt_date_cancel`:

| Field | Docs say | Why it matters here |
|---|---|---|
| `is_arrive` | *"For appointments: true if user has checked-in; false otherwise. For classes always null."* | Makes Q9 — is check-in used consistently for private lessons — **measurable** instead of a question for the client |
| `a_staff_info[].is_staff_change` | *"true means staff is substituted"* | A royalty is paid to whoever taught. Nothing else in the API says a substitution happened |
| `dt_confirm` | *"Will be zero date + time in case appointment is not yet confirmed by client"* | Confirmation is a client act with a time on it |

### Attendance: class-only as we call it — but the docs disagree, and we never tested them

`/v1/login/attendance/list` rejects an appointment key with sid `id-nx` — "The ID
value for `k_class_period` that you have specified does not exist". Measured on
live dev, 21 Aug 2026 → 27 Aug 2026: **681 dead attendance rows out of 1,018**,
every one for a session whose kind is `appointment`. Not an outage — WL is
returning a correct answer.

Consequence, and it still stands: `session.k_period` holds `k_appointment` for
appointment rows (see `src/sync/client-sessions.ts:93`), so the attendance seed
MUST filter to `session_kind = 'class'`. Appointments have exactly one attendee
already (the payer is the client), and that record is written by the
client-session sync.

**But "class-only" is our conclusion, not WL's.** Reviewing the spec on 27 Aug
2026, `AttendanceListModel` is summarised as *"Retrieves information about
clients attending a class, **appointment**, or event session"* and documents two
mutually exclusive parameters:

| Parameter | Docs say |
|---|---|
| `k_class_period` | *"The class period key. **Not used if requesting information for an appointment.**"* |
| `k_appointment` | *"The appointment key. **Not used if requesting information for a class or event session.**"* |

We only ever sent the appointment key **as `k_class_period`** — so `id-nx` was a
correct answer to a question we asked wrongly, and it says nothing about whether
`k_appointment=` works. This is the same shape of mistake as `dt_date` versus
`dt_date_local` above: a parameter name recorded as a WellnessLiving limitation.

**Not yet retested, and it cannot be settled from stored data** — `raw_wl`
recorded `request_params` as `{}` on all 29 stored attendance payloads, so what
we sent was never captured. It needs one live call with `k_appointment=`.

`request_params` being empty is its own small defect: the column exists so a
stored payload can be re-read without guessing what produced it, and for this
endpoint it holds nothing.

### `attendance/list` already carries the outcome — measured, not read off the spec

Sampled 29 stored payloads / 55 client records on 27 Aug 2026. **Every field is
present on 55 of 55:**

| Field | What it is |
|---|---|
| `id_visit` | WL's own visit status, and here the spec links the **correct** `WlVisitSid` |
| `dt_register` | *"The date the client checked in for the visit, in UTC"* — a real check-in **time**, which this project stores nowhere |
| `is_attend` / `is_visit` | attended |
| `is_truancy` / `is_penalty` / `is_pending` | booleans mirroring TRUANCY 5, PENALTY 4, PENDING 7 |
| `dt_book`, `k_visit`, `uid_book` | already read |
| `url-cancel`, `url-cancel-admin` | note the **hyphens** — not the usual `_` convention |

Observed `id_visit` distribution: **1 BOOK 45 (81.8%), 3 ATTEND 8 (14.5%),
7 PENDING 2 (3.6%)**. So real outcomes are arriving on a call this project
already makes, and [`src/sync/attendance.ts`](../src/sync/attendance.ts) reads
`is_visit`/`is_attend`/`is_truancy` but **not `id_visit`** — while migration 0029
makes `id_visit` the authoritative field the whole royalty rule turns on.

**Only `a_list_active` was ever populated** — 29 of 29 payloads; `a_list_confirm`
and `a_list_wait` were empty every time.

**There is no cancelled bucket, and that is a trap.** The spec defines
`a_list_active` as *"clients ... who haven't confirmed or **canceled**"*. A client
who cancels therefore **disappears from the response** rather than appearing with
a cancelled status. Absence from an attendance list is not evidence they never
booked, and a class cancellation cannot be counted from this endpoint at all —
only from `id_visit` on a visit we already know about.

### `/v1/purchase/receipt` shape — where the money is

Probed live 21 Aug 2026. `profile/purchase/list` carries NO money; the receipt does,
one call per `k_purchase`:

| Block | Holds | Maps to |
|---|---|---|
| `a_price` (keyed object) | `m_sum`, `m_discount`, `m_tax`, `m_tip`, `m_total`, `text_currency` | `purchase` totals |
| `a_purchase_item[]` | per item `m_price_total`, `text_currency` | `purchase_item` money |
| `a_pay_method[]` | `text_pay_method`, `m_amount`, `text_currency` | `purchase_payment` |
| `a_account_rest[]` | `text_method`, `m_amount` (can be **negative** — a balance, not a payment), `text_currency` | `purchase_account_credit` |
| `a_customer` | `text_name`, `text_mail`, `text_phone` — the payer as printed, **without a uid** | `purchase.payer_name/email/phone` |

`a_customer`'s shape comes from the WL Postman collection (bid-334942 v1.2026-07-22),
not a live probe — the 21 Aug probe recorded only the money blocks. Task 008 carries
the row to confirm it live. The receipt names only the **buyer**; the **recipient**
comes from the element endpoint below.

### `/v1/profile/purchase/list/element` — where the recipient is (probed live 24 Aug 2026)

One call per `k_purchase_item`; needs only `k_purchase_item` (no `uid`). It is the
ONLY endpoint found that says who a purchase was **for** — the purchase list is
per-payer by construction and the receipt's `a_customer` names only the buyer,
without a uid. Observed live at 244238 across five items:

- `uid_recipient` (string) + `s_recipient` (printed name) — present on **every**
  record sampled.
- `uid_payer` + `s_payer` — present on some, **null/`""` on others**, even where
  `uid_recipient` is set. Do not treat payer-absence as recipient-absence.
- The body does **NOT echo `k_purchase`** — the caller must already know which
  purchase the item belongs to (our `purchase_item` row carries it).
- Also carries per-item money (`m_cost_total`, `m_price`, discounts) and usage
  counters — not consumed; the receipt remains the money source.

Assumed but not yet seen live (task 008): a `uid` of `"0"` read as "nobody" (the
`k_location "0"` convention), and a parent-child purchase where recipient ≠ payer —
every dev sample so far is a self-purchase.

Trap: **`a_purchase_item[].k_purchase_item` comes back as a NUMBER here**, though the
list endpoint sends the same key as a string. Coerce to text or the item is lost.

### `/v1/profile/purchase/list` does NOT carry membership or refund detail (probed live 24 Aug 2026)

Board item 6.2 says the membership fields come from the purchase list. They do
not. Over 109 items the list returns EIGHTEEN fields, all of them identity:

```
a_active  a_sale  dt_add  id_purchase_item  id_sale  is_active  is_package
k_appointment  k_business  k_code  k_id  k_location  k_login_promotion
k_purchase  k_purchase_item  s_title  uid
```

No payment period, no period price, no hold, no cancellation, no renewal, no
refund. All of those are on the ELEMENT endpoint below — which is already fetched
once per purchase item, so the detail costs no extra call.

### `/v1/profile/purchase/list/element` also carries the MEMBERSHIP state (probed live 24 Aug 2026)

The same call that answers "who was this for" (above) returns 87 fields. Beyond
the recipient, these map to `purchase_item` (task 023, migration `0013`), with
live population over 109 dev items:

| Field | → purchase_item | Live | Notes |
|---|---|---|---|
| `sid_value` | same | 109 | `appointment` ×91, `service-membership` ×11, `service-limit` ×6, `class-period` ×1. The only field that says whether a row is a membership. |
| `i_payment_period` | same | 11 | Always `1` so far. |
| `m_period_price` | same | 11 | `96.00`, `230.00`, `329.00`, and `0.00` on eight. |
| `is_hold` / `dt_hold_start` / `dt_hold_end` | same | **0** | Never observed — task 008. |
| `is_cancel_pending` | same | **0** | Never observed — task 008. |
| `dt_cancel` | same | 10 | Real timestamps. `dl_cancel`, the local twin, was 0/109 and is not stored. |
| `is_renew` / `i_renew` | same | 9 / 3 | `can_renew` was 0/109 and is not stored. |
| `m_refund` | same | 5 | **Negative**: `-280.00`, `-230.00`, `-70.00`, `-42.50`. |

**Trap: `m_refund` is the string `"0"` when nothing was refunded** — not `"0.00"`,
not `""`. A truthiness check stores a zero refund against every unrefunded item in
the business. Read `"0"` as absent.

**Trap: the empty marker is `""` and `0`, not null.** Same rule as `/v1/user` —
read them as null and OMIT the column, or a refresh blanks a stored value.

The body does not echo `k_purchase`, so the caller must already know which
purchase the item belongs to (our `purchase_item` row carries it).

### `/v1/user` — the profile, and the only place the PRIMARY email is (probed live 24 Aug 2026)

One call per `uid`. The body IS the record (not keyed). It is the enrichment the
staff list defers — staff arrive with names but no contact detail. Fields that map
to `person` columns:

| Field | → person | Notes |
|---|---|---|
| `s_mail` | `email` | **The primary email.** The client report exposes only a *secondary* email, so GHL matching waits for this. |
| `s_first_name` / `s_last_name` | `first_name` / `last_name` | |
| `s_phone` / `s_phone_home` / `s_phone_work` | `phone` / `phone_home` / `phone_work` | Already `+`-prefixed; `""` when unset. |
| `dt_birth` | `date_of_birth` | Bare date (`"1989-11-14"`) or `""` — never a datetime. |
| `k_login_type` / `text_login_type` | same | Label only — never used to decide who teaches. |

Trap: WL returns `""` (not null/absent) for an unset phone or `dt_birth`. Read `""`
as null and OMIT it from the upsert, or a refresh blanks a value another source set.
Also carried but **not stored** (no person column, out of 6.1 scope): `id_gender`
(a number), `text_address` / `text_city` / `text_postal`. `/v1/member/info` gives a
login-mail *URL*, not the address; `/v1/profile/email` is an email→uid lookup
(needs `text_mail`); `/v1/profile/setting` is notification flags only.

### `/v1/schedule/class/list` — the schedule, and the ONE endpoint that wants a bare date (probed live 25 Aug 2026)

The house rule is that a WL date needs a time component. **This endpoint is the
exception**: `dt_date` and `dt_end` must be bare `YYYY-MM-DD`. Sending
`2026-08-18 00:00:00` is rejected with `date-end-invalid`. The Postman collection
documents this correctly; guessing the usual format is what made the schedule look
blocked.

It also demands a `uid`, but **the schedule it returns is the business's, not that
person's** — four different uids were probed and all four returned the identical
seven sessions. So one call covers the whole studio and its cost does not grow
with the client base. The uid is context, not a filter.

`a_session` carries, per occurrence:

| Field | → session | Notes |
|---|---|---|
| `k_class_period` | `k_period` | **Repeats weekly** — see the trap below. |
| `dt_date` | `dt_start_utc` | Global time. |
| `dtl_date` | `dtl_start_local` | Local, as WL sends it. Never re-derive it. |
| `text_timezone` | same | `"ET"` — an abbreviation, not an IANA zone. |
| `i_book` / `i_capacity` / `i_wait` | `i_booked` / `i_capacity` / `i_wait` | |
| `is_event` / `is_cancel` | `is_event` / `is_cancelled_studio` | **Strings `"0"`/`"1"`**, not booleans. |
| `is_virtual` / `is_wait_list_enabled` | same | These two ARE real booleans. |
| `url_book` | `url_book` | WL-generated, carries the period and start time. |
| `a_staff` / `a_staff_uid` | `session_staff` | k_staff and person uid, positionally paired. |

**The trap: a class id repeats.** `k_class_period` 18448467 came back SIX times in
one 38-day window — one per week, same id, six dates. Keyed on the id alone, five
weeks of teaching vanish. The key is (class, date).

**`a_staff_uid` is the only place the API names who teaches.** The purchase side
never does — see the element notes above.

**One malformed record per response.** A row arrived carrying `dtl_date` and
nothing else: no class period, no capacity, no staff. It cannot be keyed, so it is
counted and skipped rather than stored half-filled.

### `/v1/schedule/page/list` + `/element` — the ONLY route to private appointments (probed live 25 Aug 2026)

The business-wide schedule call returns **classes only**. Measured: it gave six
occurrences of one class taught by one person, while the per-client call gave
**115 visits**. Sixteen of the studio's seventeen teachers had no session visible
at all, because they teach private appointments.

`/v1/schedule/page/list?uid=` returns pointers and nothing else — `k_visit`,
`dtu_date`, `id_visit`, `k_business`. Every detail needs
`/v1/schedule/page/element?k_visit=`.

**Future only, and there is no window to widen.** The list ignores date
parameters entirely. Ongoing sync is fine (a session is caught while upcoming and
its outcome filled in later); backfill is impossible from here.

**Two shapes, told apart by which key WL fills:**

| | `k_appointment` | `k_class_period` | `k_service` |
|---|---|---|---|
| private appointment | set | null | set |
| class booking | null | set | null |

The element body also carries `a_staff` (`k_staff` + `s_name_full`) — for
appointments this is the only place the teacher appears — plus `is_checkin`,
`i_capacity`, `i_duration`, `is_virtual`, `is_event`, `dt_date_global`,
`dt_date_local` and `text_timezone`.

**TRAP: `dt_cancel` is a DEADLINE, not a cancellation.** The name invites the
wrong reading. Measured across 40 visits it sat **exactly 24 hours before the
session start on 40 of 40** — including sessions that were attended. It is the
studio's cancel-by policy time. Stored as `dt_cancel_by`; reading it as "when
this was cancelled" would put a cancellation on every session in the business.

### Services and locations (probed live 21 Aug 2026)

- **`/v1/location/list`** carries the detail: `s_title` (name) and an `a_timezone`
  object whose `text_name` is the IANA zone (`"America/New_York"`). `k_timezone` is
  a bare key, not a zone — use `a_timezone.text_name`.
- **There is NO service-detail endpoint.** `/v1/service`, `/v1/staff/service` and
  `/v1/business/service` all 404. A service's human bits (`title`, `is_package`) are
  taken from the purchase items that reference it — derived from transactions, not a
  catalogue pull.
- **Categories** need no entity: `purchase_item.text_category` from the receipt is
  enough.
- **`k_location "0"` means "no location"** — a placeholder, stored as null rather
  than a stub row (like the `"0"` placeholders WL uses elsewhere).

### Promotions and shop categories (probed live 24 Aug 2026)

Reference lookups, both confirmed working against dev — unlike the client report
(resolved - the parameter is `dt_date_local`) and the guessed service
endpoints (all 404).

- **`/v1/classes/promotion`** is **per-location** — it needs a `k_location`. At
  244238 `a_promotion` held 12 records: `k_promotion` (text key), `text_title`,
  `id_program` (a **number**, e.g. `1`), and `is_active` / `is_class` /
  `is_enrollment` / `is_select` as `"0"`/`"1"` string flags. A `k_promotion` is
  unique business-wide, so it repeats across locations and is deduped by upsert.
- **`/v1/shop/category`** is genuinely **business-wide** — it answers with no
  `k_location`. `a_shop_category` held 5 records: `k_shop_category` (text key),
  `text_title`, `text_description` (often `""`), `i_order` (numeric **string**,
  `"0"`), and `is_default` / `is_system` as real JSON booleans.
- **Both come back as JSON ARRAYS, not keyed objects** — the inverse of the usual
  WL list rule. Guessed neighbours `/v1/shop/product/list`, `/v1/store/category`
  and `/v1/classes/category` all fail, so these two paths are exact, not a family.

### The service catalogue DOES exist — under a different path (probed live 24 Aug 2026)

Task 020 concluded "WL exposes no service-detail endpoint (all `/v1/service*` paths
404), so service title/is_package are derived from purchase items." That was true for
the `/v1/service*` family. The real catalogue lives under `/v1/appointment/book/`:

- **`/v1/appointment/book/service/list`** — **per-location** (`k_location`). `a_service`
  is a **keyed object** (the usual rule, unlike promotions/shop above). Per record:
  `k_service` (text key), `s_service` (title, e.g. "Music Private | Virtual | 45
  Minutes"), `k_service_category`, `i_duration_real` (minutes; `i_duration` is 0),
  `is_bookable` (real bool), plus prices as **strings** (`f_offline_min`/`max`,
  `f_online`, `f_deposit`) and `html_description`. At 244238: **9 services**.
- **`/v1/appointment/book/service/category`** — **per-location** (`k_location`).
  `a_category` is an **array** of `{ k_service_category, s_title, i_sort (numeric
  string), hide_application }`. At 244238: 3 categories.
- **The gap (Q19):** this list is the *bookable* subset only — 9 services, while staff
  records reference ~200 and appointments name services absent here. So a referenced
  service that is not in the list is stored `is_resolved = false` (see DATA-MODEL),
  not failed. `/v1/catalog/list` and `/v1/catalog/staff/catalog/list` return shop
  **products** (48 at staff scope), a separate catalogue not modelled yet.

### Field notes worth remembering

| Field | Note |
|---|---|
| `uid` | 8 digits, the person id. Text |
| `k_staff` | 6 digits, the staff id. Text |
| `uid_staff` | always equals `uid` — a duplicate field, not a third id |
| `text_member` | 9 digits, the UI's "Client ID #". **Not** the uid, often empty, search-only |
| `k_login_type` | client type key, e.g. `1260510` = "Staff Client Profile" |
| Phones | already full international — `+NNNNNNNNNNN` (12) or `+NNNN-NNN-NNNN` (14) |
| `is_require` | inconsistently typed: `true`, `"1"`, `"0"` in the same response |
| `m_*` | money, always a quoted string |
| Client-type counts | 13 types on this business; 47 clients are "Staff Client Profile" while only 20 are staff |

## GoHighLevel

### Auth — no OAuth needed

`GHL_API_TOKEN` is a **Private Integration Token** (`pit-…`), which is already an
access token. No `/oauth/token` exchange, no refresh, no expiry to manage.

```bash
curl -s 'https://services.leadconnectorhq.com/contacts/?locationId=<LOC>&limit=20' \
  -H "Authorization: Bearer $GHL_API_TOKEN" \
  -H 'Version: 2021-07-28' \
  -H 'Accept: application/json'
```

**The `Version` header is required** — and it differs by endpoint family. Data
endpoints want `2021-07-28`; the OAuth endpoints want `v3`. Easy to get wrong.

`/oauth/location-token` needs an **Agency** token. Ours is Sub-Account level, so it
does not apply.

### The token has contacts scope only

| Endpoint | Result |
|---|---|
| `GET /contacts/` | ✅ 200 |
| `GET /locations/{id}` | ❌ 401 *token is not authorized for this scope* |
| `GET /users/` | ❌ 401 |
| `GET /opportunities/pipelines` | ❌ 401 |

Only read was tested. **Write scope is unverified** — matching will need it to set a
contact id, and there are 22,865 real contacts, so check the scopes in
GHL → Settings → Private Integrations rather than testing against live data.

### Contacts

**22,865 contacts** — against 47 WL clients. Matching is the real work.

Pagination is **cursor-based**, not page numbers:

```json
"meta": {
  "total": 22865,
  "nextPageUrl": "…&startAfter=1787077671368&startAfterId=I4B54A9Du8JQZp4EPvfX",
  "currentPage": 1, "nextPage": 2
}
```

`startAfter` (a timestamp) and `startAfterId` together — both are needed to resume.

Fields available for matching: `id`, `email`, `phone`, `firstName`, `lastName`,
`dateOfBirth`, `tags`, `dateAdded`, `dateUpdated`, `customFields`, plus address
fields. Phones are in the same `+1…` shape WL uses.

One observed contact carried `tags: ["closed","wellness member"]` — WL members
appear to be tagged, which may help matching.

### What a contact actually carries — measured over 1,098 stored searches

Measured 26–27 Aug 2026 from `raw_ghl`, not from the docs. 1,098 searches, all
`/contacts/search`, all HTTP 200. Payload has exactly three top-level keys:
`total`, `traceId`, `contacts`. 325 contact objects, 307 of them distinct, across
506 clients searched.

A contact object has **38 keys**. `customFields` and `tags` were present on
**325 of 325** — always arrays, never absent.

**`customFields` is sparse, and only three fields exist.**

| | |
|---|---|
| Contacts with an **empty** `customFields` array | **254 of 325 (78%)** |
| Distinct field ids in the whole location's data | **3** |
| Shape | `[{id, value}]`, `value` always a string in this data |

| Field id | Contacts | Values |
|---|---|---|
| `ibhlYPvuAeAA3N8iJqv6` | 54 | `DJ`, `PIANO`, `LIVE SOUND`, `VOICE`, `MUSIC PRODUCTION` |
| `7NBvgQs2s08waeVnsl6J` | 21 | 20 distinct, 9–190 chars — free text |
| `f48pVfYaewIDJl35G1X1` | 2 | 1 distinct, 12 chars |

**The contact response carries field ids, never field names.** The mapping is
`GET /locations/{locationId}/customFields`, and that is in the 401 list above —
this token has contacts scope only. So a stored field can be reported but not
labelled until either the client says what it is, or the token gains
`locations.readonly`. Guessing from the values is exactly the trap: the first one
*reads* like a programme, which is what makes a wrong name believable.

**`tags` is a flat array of lowercase strings.** 44 distinct; 1–11 per contact, 2
typical. The mix matters more than the count — program codes sit next to
operational state:

`wellness member` 167 · `closed` 164 · `wellness retention` 71 · `clf` 56 ·
`sdc` 48 · `hlf` 48 · `wlf` 42 · `lead reactivation` 32 · then `nl stage 1/2/3`,
`appointment no show`, `missed incoming call`, `power dialer clean up`,
`mal inbox`, `no phone number`, `no email`, `dnd`, `bad email`, `disqualified lead`.

Two consequences recorded in [DATA-MODEL.md](DATA-MODEL.md): a stored tag set must
**replace** rather than merge, because GoHighLevel retires these; and the tag set
must never be exposed to the client it describes.

### The Version header: `2021-07-28` works, the docs now say `v3`

`GHL_API_VERSION` is `2021-07-28` and every measured call above succeeded with it.
But the current marketplace docs show `Version: v3` on `/contacts/search`,
`/contacts/{id}` and `/locations/{id}/customFields`, and there is now a page
titled "Contacts API v3" — so there appear to be two generations live.

**Not measured.** Nothing here has been retried with `v3`, so this is a flag, not
a finding. The header is configuration (`GHL_API_VERSION`), so testing it costs an
env change rather than a code change.

### GHL always returns a trace id

```json
"traceId": "cdbc99cb-68d5-4250-8213-06fceb309aa4"
```

A real UUID, on every response — unlike WL's `k_log`. Worth storing and quoting on
a support ticket.


## `/v1/report/query` — the only endpoint that lists clients

Measured 26 Aug 2026. `cid_report` 689 is WL's "Client List". It agrees with the
portal exactly: **517 activated clients**, and all twelve client-type tiles match
one for one. 1,285 across every status.

### `o_member_status` only distinguishes ACTIVATED, and the row carries no status

Measured 26 Aug 2026, full paged counts:

| `o_member_status` | Distinct clients |
|---|---|
| `[]` (empty) | **1,285** — every status |
| `[3]` | **517** — the portal's "Activated" |
| `[1]` | 1,285 — **ignored**, returns everyone |
| `[2]` | 1,285 — **ignored**, returns everyone |

So `[3]` is the only value that restricts; WL treats any other code as no filter.
And the report ROW has no activated/deactivated field — only a client *type* label
(`text_client_type`, e.g. "Cancelled Client"), which is **not** the status: "Inactive
Client" and "SDC Client" appear among the activated 517 *and* among the deactivated
remainder. Consequence for the sync: to know each client's activation we fetch `[3]`
(the activated set) and `[]` (everyone), and tag `person.is_active` by membership —
there is no single-call way to get status per row. See migration 0027.

### It is asynchronous, and it fails silently

The response is `status: "ok"` with `a_row: []` while the report is still being
built. The only thing that says so is `id_report_status`:

| `id_report_status` | Meaning |
|---|---|
| `2` | queued. `dtu_complete` null. **The rows are meaningless, not empty.** |
| `3` | complete. `dtu_complete` set. Zero rows now genuinely means nobody. |

A filter matching nobody and a filter matching 229 people **both** returned 0
rows on the first call and differed only on the second. Trusting the first answer
stores zero clients and reports a clean run — the worst kind of failure, because
it looks like success. WL caches per filter, so any change to `json_filter`
starts a new report and its first call is always queued.

Only the FIRST call may set `is_refresh: 1`. Setting it on every poll restarts
the report and the loop never converges.

**We poll ACROSS queue invocations, not in a sleep loop.** A build can take longer
than the 60s function budget, and a worker sleeping through it is a worker doing
nothing while the clock runs out. So the client-list pass is a state machine
(`src/sync/pass.ts` `clientListReportStep`): it sends `is_refresh: 1` once, saves a
handle in `sync_job_state` BEFORE polling, then each later invocation sends
`is_refresh: 0` once and `defer`s on a 5/10/20/30s backoff if still building. A
crash mid-poll resumes from the saved handle (the filter is deterministic, so the
same build is read, not regenerated); a build past a 10-minute deadline is
abandoned and restarted.

### `o_date` is mandatory, and it excludes without saying so

Omitting it is rejected outright (`end-date-not-set`), so there is no "no date
filter" option. And `id_report_date: 4` means **client since date**, so the
window silently drops anyone who joined outside it.

**Measured: `2010-01-01 .. 2026-12-31` returned 516 activated clients where the
portal shows 517.** One client, joined before 2010, missing with no error of any
kind. The window we send is therefore `1900-01-01 .. 2100-12-31` — the only way
to say "everyone" is to name a range nobody can fall outside.

### Rows are positional, and some column ids are business configuration

`a_row` holds bare arrays; the column ids are in `a_field`, and the order comes
from how the report is configured in the portal. Some ids are this business's own
— `field-custom-378723`, `field-custom-373189`, `field-custom-879703`.

Map by field **name**, never by index. Reading `row[5]` because email sits there
today would write phone numbers into the email column the first time somebody
adds a column in the WL UI. Nothing we read is a `field-custom-*`, so
reconfiguring those cannot break the sync.

Mapping was confirmed by joining 25 API rows against the portal's own CSV export
of the same 25 clients: **23 of 26 CSV columns matched on all 25 rows**; the
other three are blank for all 25, so there was nothing to compare. The portal's
"Client" column is `field-general-2.text_name` + `field-general-1` joined, in
that order. `o_note.text_note_list` matches too — the API carries slightly MORE
text than the CSV export, which truncates.

### Teachers

`k_login_type` `1260510` is "Staff Client Profile" — **25 activated**, exactly
what the portal shows, and the same 25 names.

`docs/DATA-MODEL.md` previously recorded this approach as rejected: *"47 clients
carry it; only 20 are staff"*. That measurement was over **every status**, where
the count is indeed 47. On activated clients it is 25. The old finding was not
wrong, it was counting a different population.

### `a_dynamic` decodes the column ids, and WL's own titles confirm the mapping

The response carries `a_dynamic`: one entry per configured column, with
`text_title`, `text_title_export`, `a_type` and the `is_dynamic` / `is_export` /
`is_show` / `is_store` / `is_order` flags. It is how to decode a `field-*` id
without guessing, and it confirmed every mapping independently of the CSV:

| Field id | WL's own `text_title` |
|---|---|
| `field-general-1` | Last Name |
| `field-general-2` | First Name |
| `field-general-3` | **Username** |
| `field-general-4` | Phone Number |
| `field-general-5` | Home Phone Number |
| `field-general-6` | Work Phone Number |
| `field-general-7` | Date of Birth |
| `field-general-8` | Gender |
| `field-general-9` / `-city` / `-zip` | Address / City / ZIP-Postal Code |
| `field-general-11` | **Client ID** |
| `field-general-12` | Referred by |
| `field-general-14` | Status |
| `field-general-15` | Time Zone |

Two of those are worth stating out loud.

`field-general-3` is titled **Username**, not Email — but the values are email
addresses and matched the CSV's "Email" column on all 25 rows. In WL the username
IS the email, so mapping it to `person.email` is right; the title is not.

`field-general-11` is titled **Client ID**, which is exactly what DATA-MODEL warns
about: the WL UI's "Client ID #" is `text_member`, a different identifier from
`uid`. Mapped accordingly.

We still map by field **id** rather than by title. Titles are business-editable
and localisable; the `field-general-*` ids are WL's own. `a_dynamic` is the
decoder ring, not the key.

### What the official documentation does not say

https://apidoc.wellnessliving.io/v1reportquery-28700318e0 documents every request
field and the `a_dynamic` map. It says **nothing** about:

* the endpoint being asynchronous — no mention of `id_report_status`,
  `dtu_queue`, `dtu_start`, `dtu_complete`, `s_report`, `i_cas_change`
* what the `id_report_date` values mean
* what the member-status codes are

All three were established by measurement, and all three decide whether a sync
returns the right people or silently returns none. `/v1/report/data` is a
**different** endpoint (GET, `id_report` rather than `cid_report`) and is not what
we use.
