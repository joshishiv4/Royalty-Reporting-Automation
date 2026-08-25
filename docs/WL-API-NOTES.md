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
| `/v1/login/attendance/list` | `date-incorrect` | **unsolved** — every date format tried fails |
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

**3. What are the correct parameters for `/v1/login/attendance/list`?**
It returns `date-incorrect` for `dt_date` in every format tried, including the
`YYYY-MM-DD HH:MM:SS` form that other endpoints require.

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

### GHL always returns a trace id

```json
"traceId": "cdbc99cb-68d5-4250-8213-06fceb309aa4"
```

A real UUID, on every response — unlike WL's `k_log`. Worth storing and quoting on
a support ticket.
