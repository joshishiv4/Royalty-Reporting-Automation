---
id: 019
title: P5.3 — save clients into person without duplicates
status: backlog
priority: high
depends_on: [018]
created: 2026-08-21
---

# P5.3 — save clients into person without duplicates

Board item 5.3 (HRRAFEBAV-60). Turns the report's client rows into `person` rows,
deduped — the payoff that makes purchases cover real students, not just staff.

## Goal

Parse each client row from the report into a `person` row and upsert on `uid`, so
re-reads and overlapping reports never duplicate a person. This is what finally grows
`person` beyond staff and lets the purchase sync (done) enumerate students.

## Scope

- A parser: report client row -> `person` (uid, names, email, phone, k_login_type,
  text_member, etc. as the report provides), keeping every WL key as text.
- Upsert on `uid` — the dedup, already proven for staff.
- `raw_link` each person row to its report payload (`table_name='person'`).
- Re-use the existing writer plumbing (`storeRawWl`, `linkRows`).

## Out of scope

- Requesting/reading the report (017/018) — this consumes the parsed rows.
- Matching to GHL / royalty calc (M04).

## Acceptance criteria

- [ ] A report page's clients become `person` rows, upserted on `uid` (no dupes on
      re-run or across overlapping reports)
- [ ] All WL keys stored as text; no host in any stored record
- [ ] Each person links back to its report payload via `raw_link`
- [ ] After a full client sync, the purchase sync (already built) can seed from the
      new `person.uid` rows — verified end to end against UAT
- [ ] Parser unit tests + a live proof

## Constraints & notes

- DATA-MODEL: one human is one `person`; `text_login_type` never identifies a teacher.
  A client and a staff member can share a uid — upsert, don't insert.
