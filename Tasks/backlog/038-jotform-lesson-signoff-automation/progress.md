# Progress — 038 Jotform lesson sign-off automation

## Last step

**20 Nov 2026** — research complete; requirements captured in `task.md`. No code
written, nothing in `src/`, `api/` or `supabase/` changed. Waiting on the user for
access (Jotform key, Drive, sender, WL Webhook Key) and the open questions.

**Next step for whoever picks this up:**
1. Plan (do not build yet — CLAUDE.md: explain the plan, wait for a go-ahead) the
   **WL webhook receiver** in `api/`. It is the only piece blocked on nothing, and WL
   needs its URL before it will activate the subscription.
2. Design the sign-off tables after reading `docs/DATA-MODEL.md`.
3. Record the WL findings below in `docs/WL-API-NOTES.md` (not done yet — the user
   had not approved doc edits when the session ended).

## Checklist

- [x] Understand the manual process (sample PDF, Drive unmerged + merged folders)
- [x] Find where FI lives in WL (client groups)
- [x] Confirm WL relationship (parent) API — **does not exist** (WL Support)
- [x] Confirm WL webhooks cover attendance (Schedule group) — WL Support
- [x] Measure volume and data gaps
- [ ] Studio answers to open questions (task.md)
- [ ] Access: Jotform key + form id, Drive, sender, WL Webhook Key
- [ ] Record WL findings in `docs/WL-API-NOTES.md`
- [ ] Plan + build webhook receiver; send URL to WL
- [ ] Sign-off data model, Jotform link + submission webhook, reminders
- [ ] Drive upload, month-end merge
- [ ] EEDA pilot, then all FIs

## Findings (measured, not assumed)

### FI = WellnessLiving client group

- `GET /v1/member/group/list?is_return_members=1` — **not in WL's v1 docs, works
  live** (`status: ok`). It is the SDK's `Wl\Member\Group\GroupList\ListModel`.
  One call returns all **28** groups: `k_member_group`, `text_title`, `text_icon`,
  colours, `id_member_group_shape`, and `a_uid` (members). Without
  `is_return_members=1` you get names only.
- `a_member_group` arrives as an **array** here (CLAUDE.md says WL lists are keyed
  objects) — use `Object.values()`, which handles both.
- Per client: `GET /v1/user?uid=…` → `a_member_group: ["18454","20512"]` (keys only).
- The client-list report (`/v1/report/query`, cid 689) also filters by
  `o_member_group: ["<key>"]` — verified: `18454` → 216 rows, `20512` → 3.
- Groups: `SDC Clients` (18454, 216) is the in-scope flag. FI-like groups: ISS 63,
  AIM 22, RAYIM 11, BHOOD 11, HALO 8, METROPOLITAN 7, ACDS 7, MNY 5, CMA 4,
  Brightway Living & Learning 4, A1UC 4, F.R.E.E. Services 4, YAI 3, RCIL 3,
  EEDA 3, CFS 2, PCCS 2, Shema Kolainu 2, COU/AVSPNY/EOCS/HASC/YEDEI/PPL/It's My
  Place 1 each. Also `Self Pay` (4) and `Music Lee Inclided Guy` (19).
- Of 216 SDC members: **186 have exactly one other group, 28 have none, 2 have two**
  (uid `36453855` ISS + Self Pay; uid `38395038` Self Pay + ACDS).
- Untagged but recently attending: uid `36453372` (attended 14 Nov 2026 — and the
  admin already produced a merged file for this student, so the FI is known, just
  not tagged), uid `61948553` (25 Sep 2026), uid `48353734` (15 May 2026). The
  other 25 attended years ago or never. Names: query `person` by uid.
- WL keeps **current** membership only — snapshot the FI per lesson.
- Not FI sources: "Broker Information (If Applicable)" custom field (free text,
  self-direction broker, ~20/308); client type "SDC Client" (type, not FI);
  "Institution" clients (partner orgs that pay directly). No FI appears among
  purchase payers (23,694 purchases searched).

### Parent / signer

- **WL Support (George), Nov 2026: there is no API for client relationships**, and
  it is not a permissions issue. The profile's "Relationships" section is UI-only.
  Feature request logged with WL, no timeline.
- Probed live, all 404: `/v1/family/relation` (+ `/list`, `/relation`, `s`),
  `/v1/profile/relation`, `/v1/profile/family`, `/v1/login/relation`,
  `/v1/relation`, `/v1/family`. The SDK model `Wl\Family\Relation\RelationModel`
  exists in WL's 2024 spec but is not exposed. **Never POST/DELETE it** — those
  methods create/delete relationships.
- WL's suggested workaround "the parent shows as the booking party" **does not work
  here**: for appointments (4,412 of 4,423 sessions) `/v1/login/attendance/list`
  records carry no `uid_book`/`dt_book` at all, and `/v1/schedule/page/element` has
  no booker either. Staff also book most lessons in the back office. (Our
  `attendance.uid_book` column is null on every SDC row; `docs/WL-API-NOTES.md`
  §"attendance/list already carries the outcome" says `uid_book` is present — that
  was class sessions in Aug 2026 and is not true for appointments now. Fix the doc.)
- What exists: `/v1/user` → `s_mail` — 215 of 216 SDC students have one; 31 share
  their email with another client (usually the parent's profile — e.g. uid
  `32277096`'s profile email equals the linked parent's). Custom field
  "Secondary Email" (`k_field` 378723) filled on 48 of 216. **Custom fields appear
  in `a_custom_field` only on some profiles — look up by `k_field`, treat missing as
  blank.**

### Attendance and visit endpoints

- `id_visit`: 1 Booked, 3 **Attended**, 4 Penalty (late cancel), 5 Truancy
  (no-show), 6 cancelled (observed), 7 Pending.
- `GET /v1/visit/status?k_visit=…` — in WL's v1 index, **works live**. Returns
  `id_visit`, `dtl_date` (local), `dt_date` (UTC), `text_title`, `text_staff`,
  `i_duration`, `uid`, `k_service`, `k_staff`, `k_location`. One call = all form
  data for a lesson except student name and FI.
- `GET /v1/schedule/page/list?uid=…&is_past=1&dtu_start=…&dtu_end=…` — a client's
  visits (`k_visit`, `id_visit`, `dtu_date`). This is the reconciliation source.
- `GET /v1/member/info` is the self-check-in summary — no groups, no relationships.
- Volume: **Oct 2026 — 507 attended lessons by 99 SDC students** (~500
  signatures/month).

### Sync gap (found, not fixed — user said "later")

One SDC student (uid `34064623`) has **12** attended visits in Oct 2026 in WL
(Attendance History "Total Appointments 12", and 12 pages in her merged PDF); our DB
had **11**. Missing: `k_visit 793205237`, Sat 17 Oct 2026 13:00 local, "Music For
Everyone | Live Performance Instruction | 15 Minutes", Attended. Neither the session
nor the attendance row exists in our tables. Root cause not investigated. This is
why the design needs the webhook **and** reconciliation, not the nightly sync alone.

### WL webhooks (WL Support reply, Nov 2026)

- Topics: Business, Location, Staff, Client, Purchase, Service, Asset, **Schedule**.
- **Schedule** = client visit status changes incl. check-in, no-show, late cancel.
  Appointments + classes "to be confirmed at setup". Statuses the system applies
  automatically may not fire — keep an API backstop.
- Activated by WL's team. They need: business name + ID **334942**, event groups,
  **HTTPS endpoint URL**. Then they send a **Webhook Key** to verify requests.
- Endpoint must return **2xx within 5 s**; WL retries with backoff; events after the
  retry window are lost. Payload is lightweight (ids) — fetch details via
  `/v1/visit/status` or `/v1/schedule/page/element`.
- Reply to WL drafted (business details, Schedule + Client groups, asks: appointments
  included? payload has `k_visit` + `uid`? retry window? Client event on group /
  custom-field change?) — **endpoint URL left as a placeholder** until deployed.
- No public payload schema; test once enabled.

### Jotform (researched from Jotform docs, Nov 2026)

- **Jotform Sign has no public REST API** — no create/prefill/send/status/reminders.
  So the design uses a single Jotform **Form** with **prefilled links**
  (`formURL?uniqueName=value`); read-only fields can still be altered via URL, so
  re-verify submissions server-side.
- REST API: `APIKEY` header; base `api.jotform.com` (also `eu-api.`, `hipaa-api.`).
  Endpoints: `GET /form/{id}/submissions` (filter/limit/offset), `GET /submission/{id}`,
  `GET|POST /form/{id}/webhooks`, `DELETE /form/{id}/webhooks/{id}`. Daily call
  limits by plan (Bronze 10k, Silver 50k, Gold 100k).
- Submission webhook: multipart/form-data with `formID`, `submissionID`, `rawRequest`
  (JSON string). No documented signature or retry — use a secret in the URL,
  idempotency on `submissionID`, and polling as backstop.
- **No supported submission-PDF endpoint** — plan to render/merge PDFs ourselves
  (`pdf-lib`), or confirm an option with Jotform.
- Plans: Bronze $39 (1,000 submissions/mo) covers ~500/mo as a Form. HIPAA only on
  Gold/Enterprise (Drive + webhooks allowed under HIPAA).
- No native WL ↔ Jotform integration; WL's Zapier app has no visit/attendance trigger.

## How the measurements were taken (to reproduce)

- Supabase read via PostgREST with the service role from `.env`
  (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`); WL via OAuth client credentials from
  `.env` (`WL_AUTH_HOST`/oauth2/token, then `WL_API_HOST` with `id_region` +
  `k_business`). Throwaway Node scripts in a scratch dir, read-only, GET only.
- `node_modules` in this repo was **empty** at the time — `dist/` imports fail
  (`zod` missing). Run `npm install` before using `scripts/` or `dist/`.
- `raw_wl` is too large to scan by endpoint without a time/key filter — queries
  ordering it time out (statement timeout). Filter by `target_key`.
- PostgREST caps responses at 1,000 rows — page or count with `Prefer: count=exact`.

## Phase 1 built — 25 Nov 2026 (branch `features/HRRAFEBAV-162`)

Scope changed by the user on 25 Nov 2026 for phase 1: **trigger is the hourly
sync, not the WL webhook**; **every email goes to one address, `SIGNOFF_TO`**
(the admin), not the parent; reminders also go there (phase 2); start date
**24 Nov 2026**; classes **Music / DJ / Music Production For Everyone** (LPI and
In-Home are variants of those); SMTP for sending.

Built: migration `0070` (`member_group`, `member_group_member`,
`lesson_signoff`); `src/sync/member-groups.ts`; `src/sync/lesson-signoff.ts`;
passes `member_group_sync` + `lesson_signoff_sync` in the hourly wave and a
`lesson-signoff` job; config `SIGNOFF_*`, `JOTFORM_FORM_HOST`, `JOTFORM_FORM_ID`;
`sync-run.yml` passes them. 34 tests, mutation-checked. Docs: ARCHITECTURE,
DATA-MODEL, RUNBOOK, WL-API-NOTES, STATUS.

Jotform test form `JOTFORM_FORM_ID` checked through the API: fields `student`,
`date`, `teacherName`, `courseCode`, `fi`, `signature`; prefill verified in a
browser. Course Code and FI not yet read-only; account on the Free plan.

**Before it can send:** apply `0070`; set `JOTFORM_FORM_HOST` and
`SIGNOFF_START_DATE` in `.env` and as GitHub secrets (with `SIGNOFF_TO`,
`JOTFORM_FORM_ID`); then a first run against live data.

**Later on 25 Nov 2026:** `0070` applied by the user; `member_group_sync` ran (28
groups). Teacher lookup fixed to fall back to `k_staff` (appointments have
`session_staff.uid` null). Dry run: 6 lessons of 24 Nov would be emailed — **none
sent**, user wants to hold. User made Course Code and FI read-only and added a
**hidden `lessonId`** field (qid 16). The link now carries `lesson_signoff.id` (UUID)
as `lessonId` — chosen over `k_visit` (guessable, exposes WL keys). Why it is
needed: identical visible forms for two same-day lessons (an SDC student, 30 Oct
2026, 5:30 and 7:30 PM, same teacher, class and FI). Phase 2 matches submissions
on it. Unchecked: whether the hidden field is left off Jotform's PDF.

## Log

- **2026-11-19** — Assessment of the manual process; FI search (custom fields,
  client types, payers); Jotform + WL integration research; volume measured.
- **2026-11-19** — FI found as client groups; `/v1/member/group/list` discovered.
- **2026-11-19/20** — Relationship API probed (404s); email to WL drafted; WL
  confirmed no relationship API; booking-party workaround measured and rejected.
- **2026-11-20** — WL confirmed Schedule webhooks; reply drafted. `/v1/visit/status`
  verified. Sample PDF + Drive unmerged/merged layout captured. Sync gap found.
  User decisions recorded (per lesson, month-end deadline, attended only, parent
  signs, no visible form change, staff will tag untagged students). Handoff written.
