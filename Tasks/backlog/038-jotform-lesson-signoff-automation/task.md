---
id: 038
title: Jotform lesson sign-off automation — per-lesson parent signature, reminders, Drive, month-end merge
status: backlog
priority: high
depends_on: []
created: 2026-11-20
---

# Jotform lesson sign-off automation (Spin DJ Academy)

> **Handoff note.** This task was researched in one long session (19–20 Nov 2026)
> and is being continued from another account. Everything decided, measured and
> still open is written here and in `progress.md`. Read both before asking the
> user anything — most questions are already answered below.

## Goal

Replace the admin's manual process with automation:

1. **Today (manual):** after each lesson the admin builds a Jotform "Student Lesson
   Confirmation Form" by hand, emails it to the parent to sign, gets notified when
   signed, and the signed PDF lands in Google Drive. At month end the admin merges
   every per-lesson PDF into **one file per student per FI**.
2. **Wanted:** WellnessLiving attendance drives it end to end — build the form link,
   send it to the parent, follow up until signed, store the PDF in Drive, and build
   the month-end merged files. No manual form building.

**FI = Fiscal Intermediary** — the organisation that funds a self-direction (SDC)
student. In this studio the FI is a **WellnessLiving client group** (see below).

## Decisions already made by the user (do not re-ask)

| Topic | Decision |
|---|---|
| Signature granularity | **One signature per lesson** (not monthly) |
| Deadline | **Month end** — every lesson of a month must be signed by its last day |
| Which visits | **Attended only** — `id_visit = 3`. No no-shows, no late cancels |
| Who is in scope | Students in the WL client group **"SDC Clients"** (key `18454`, 216 members) |
| FI value | The name of the student's other client group (`text_title`, e.g. `ISS`, `AIM`, `EEDA`). **"Self Pay" counts as an FI value** — merged files exist named `… - SELF PAY`. Abbreviations are what the PDFs print; full names are not needed |
| Who signs | **The parent, even for adult (22+) students** |
| Form changes | **The visible form must not change** (no new visible fields). Whether a *hidden* field is acceptable is still open — see Open questions |
| Untagged students | Staff **will** add the missing FI group in WL for the SDC students that have none. Until tagged, skip + report (do not send with a blank FI) |
| Students in two groups | User will say later which FI applies. Until then **hold + flag**, never guess |
| Webhook relationship | Use WL **Schedule** webhooks as the trigger, with an API reconciliation backstop |

## The form (from a real submitted sample)

Title "Student Lesson Confirmation Form", branded header (Music For Everyone & Spin DJ
Academy). One page. Looks like a **Jotform Form**, not Jotform Sign (no Sign audit
page) — confirm in the studio's Jotform account.

| Form field | Example | Source |
|---|---|---|
| Student | `<First> <Last>` | `GET /v1/user` → `s_first_name` + `s_last_name` |
| Date | `Friday, October 30, 2026` | `GET /v1/visit/status` → `dtl_date` (local) |
| Teacher Name | `<Teacher>` | `/v1/visit/status` → `text_staff` |
| Course Code | `MUSIC FOR EVERYONE - LIVE PERFORMANCE INSTRUCTION - 60 MINUTES` | `/v1/visit/status` → `text_title`, upper-cased, `" \| "` → `" - "` |
| FI | `ISS` | `GET /v1/member/group/list` → group `text_title` |
| Signature | drawn | parent signs |

There is **no time** on the form — a student can have several identical lessons on
one day (measured: one student had two identical 120-minute lessons with the same
teacher on 30 Oct 2026, and two identical 45-minute lessons on 7 Oct and 14 Oct).

## Google Drive layout (from the studio's real folders)

```
OCTOBER 2026/
├── OCTOBER 2026 - UNMERGED/
│   ├── ISS - OCTOBER 2026/
│   │   └── First-Last-MM-DD-YYYY.pdf          ← one per lesson
│   ├── AIM - OCTOBER 2026/ …
│   └── …                                       ← one folder per FI per month
└── OCTOBER 2026 - MERGED/                      ← flat, all FIs together
    ├── FIRST LAST - ISS.pdf                    ← one per student per FI, UPPER CASE
    └── …                                       ← one page per lesson, date order
```

**Defect in today's naming:** several lessons on one day produce the *same* file name
(three files named `First-Last-10-30-2026.pdf` were seen). Drive allows it, but the
files are indistinguishable. **The automation must add the start time**:
`First-Last-MM-DD-YYYY-HHMMAM.pdf` (e.g. `…-10-30-2026-0530PM.pdf`). The merged file
name stays `FIRST LAST - FI.pdf`.

## Target flow

1. **Trigger:** a visit becomes Attended (`id_visit = 3`).
   - Primary: WL **Schedule** webhook → our endpoint (payload is lightweight; carries
     ids — expected `k_visit` and `uid`, to be confirmed on first test).
   - Backstop: daily reconciliation per SDC student via
     `GET /v1/schedule/page/list?uid=…&is_past=1&dtu_start=…&dtu_end=…` (returns
     `k_visit`, `id_visit`, `dtu_date`). Needed: the nightly sync is **proven to miss
     lessons** (see progress.md, "Sync gap").
2. **Enrich:** `GET /v1/visit/status?k_visit=…` → date/time, title, teacher, duration,
   `uid`. Student name + signer email from `/v1/user`. FI from the cached group list.
   **Record the FI as of the lesson date** (WL keeps only current membership).
3. **Gate:** skip + report if the student has no FI group, or two groups (until the
   user decides), or no signer email.
4. **Create a sign-off request** (one per `k_visit`, idempotent) and build a
   **prefilled Jotform link** to the single master form (URL params:
   `formURL?field=value&…`). One form serves every lesson — no per-lesson forms.
5. **Send** the link to the signer (sender channel still open — SMTP vs GHL).
6. **Remind** while unsigned: e.g. +3 days, +7 days, final 3 days before month end;
   1 day before month end the admin gets the list of everything still unsigned.
7. **Receive** the Jotform submission webhook → verify values against our record →
   mark signed → produce the PDF → upload to
   `<MONTH YEAR> - UNMERGED/<FI> - <MONTH YEAR>/First-Last-MM-DD-YYYY-HHMMAM.pdf`.
8. **Month end:** merge each student's signed lesson PDFs per FI, in date+time
   order, into `<MONTH YEAR> - MERGED/FIRST LAST - FI.pdf`; report anything unsigned.

## Scope

- WL webhook receiver (verify Webhook Key, store raw event, 2xx within 5 s, process
  async, idempotent — WL retries with backoff).
- Reconciliation job (backstop).
- Sign-off request store (new tables — read `docs/DATA-MODEL.md` first, per CLAUDE.md).
- Jotform: prefilled-link builder, submission webhook receiver, polling fallback.
- Email sending + reminder schedule.
- Drive upload (per-lesson) and month-end merge (e.g. `pdf-lib`).
- Admin report: unsigned / skipped (no FI, two FIs, no email).
- Pilot on one small FI (EEDA, 3 students) before all FIs.

## Out of scope

- Changing the visible form layout.
- Jotform **Sign** — it has no public API (see progress.md); the design uses a Form.
- Creating/deleting WL client relationships, groups or fields through the API.
- Fixing the sync gap itself (user said "later" — separate task).

## Acceptance criteria

- [ ] An SDC student's lesson marked Attended in WL produces exactly **one** sign-off
      request, even if the webhook is delivered more than once.
- [ ] A lesson the webhook missed is picked up by reconciliation within a day.
- [ ] The prefilled form shows Student, Date, Teacher, Course Code and FI exactly as
      in the sample PDF format.
- [ ] Unsigned requests get reminders on schedule and stop once signed.
- [ ] A signed submission is matched to the right lesson — including two identical
      lessons on the same day — and stored under the right FI/month folder with a
      unique, time-stamped file name.
- [ ] At month end each student has one `FIRST LAST - FI.pdf` per FI, one page per
      attended lesson, in date+time order, and the page count equals WL's attended
      count for that student/month.
- [ ] Students with no FI / two FIs / no email are never sent a form; they appear in
      the admin report instead.
- [ ] No WL/Jotform/Google secret appears in source, logs or stored records; hosts are
      configuration (CLAUDE.md rules).
- [ ] `docs/` updated in the same commit as each change (CLAUDE.md table).

## Open questions (owner: studio, unless noted)

1. **Two-group students** (ISS + Self Pay; Self Pay + ACDS) — which FI? *User will answer.*
2. **Grace period** — can late-month lessons be signed a few days into the next month
   before merging, or is the merge exactly on the last day?
3. **Hidden field** — is a hidden (never shown, not on the PDF) lesson-id field
   acceptable? Without it, two identical same-day lessons can only be matched by send
   order. Strongly recommended.
4. **Sender** — which address do parents receive these emails from today? SMTP (studio
   mailbox) or GoHighLevel? GHL needs a new token with conversations/messages scope;
   ours is contacts-only.
5. **Signer email for adults** — the profile email may be the student's own. Plan:
   staff-only WL custom fields *Signer*, *Parent/Guardian Name*, *Parent/Guardian
   Email*, read from `/v1/user` → `a_custom_field`; fall back to `s_mail`.
6. Confirm the current lesson form is a Jotform **Form** (not Sign), plan name, HIPAA.
7. Legal standing of a Jotform **Form** signature field (ESIGN/UETA) — ask Jotform.

## Blocked on access (owner: user)

- **Jotform API key** (Full Access; Settings → API → Create New Key), the **form ID**
  (`jotform.com/build/<FORM ID>`), and plan name. Goes in env config, never in chat
  or the repo.
- **Google Drive** write access to the studio's month folders (they are "Shared with
  me" — plan: a Google service account the studio shares the folders with).
- **Email sender** credentials (see open question 4).
- **WL Webhook Key** — WL sends it after the subscription is activated. The
  subscription needs our deployed **HTTPS endpoint URL** first, so the webhook
  receiver must be built and deployed before replying to WL.

## Resources

- `progress.md` — every measurement, endpoint finding and correspondence summary.
- The screenshots the user shared (sample PDF, Drive folders, WL profile pages) are
  **not** stored here — they contain client names and emails. Ask the user to re-share
  if needed.
