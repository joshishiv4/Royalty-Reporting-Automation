---
id: 010
title: M03a — writer and raw_link for staff and purchases
status: done
priority: high
depends_on: [013]
created: 2026-08-21
---

# M03a — writer and raw_link for staff and purchases

Sub-task of [009](../009-m03-sync-engine-writer/task.md) (the M03 PRD). This is
the writer with no queue yet: read → store raw → parse → typed rows → link.

> **Narrowed 2026-08-21 to the staff→person slice.** The purchase/payment/service
> path is entangled with FK ordering (`purchase.k_location` → `location`,
> `purchase.uid_payer` → `person`) and the client-enumeration boundary (purchases
> are fetched per client uid). That is its own sitting — split to **task 014**. This
> task delivers `raw_wl` + `staff/list → person` + `raw_link`, proven live.

## Goal

Turn a WL response into stored data. Given a fetched endpoint, persist the raw
payload in `raw_wl`, parse it into the typed tables, and record `raw_link` rows so
every typed row traces back to the payload it came from. Idempotent: re-running the
same fetch updates in place, never duplicates.

## Scope

- A `raw_wl` write per fetch: `source_endpoint` (path only, no host), `k_business`,
  the record key or cursor, the payload.
- Parsers: `/v1/staff/list` → `person` (the 14 with a teaching flag),
  `/v1/profile/purchase/list` + receipt detail → purchase / payment / service rows
  (the royalty rows — the purchase **item** is the royalty row, per DATA-MODEL).
- `raw_link` rows (`table_name`, `record_key`, `raw_wl_id`) for every typed row.
- Upserts on the WL natural key: `uid`, `k_purchase`, purchase-item key. **Confirm
  each table's real unique constraint in the migrations before relying on it.**

## Out of scope

- The `sync_queue` loop and retry wiring — task 011.
- Resume/cursor and the route — task 012.
- attendance, margin, wider client base — deferred (see 009).

## Acceptance criteria

- [x] A staff-list fetch writes `raw_wl` + `person` rows + `raw_link`, joinable
      back to the payload
- [ ] ~~Purchase-list + receipt → purchase/payment/service rows~~ → **moved to task 014**
- [x] Re-running the same fetch upserts (no duplicate rows) on the natural key
- [x] No host in any `raw_wl.source_endpoint` or stored record
- [x] Parser tests (staff) + live proof against dev; mutation-verified — captured UAT payloads as fixtures; mutation-proven

## Constraints & notes

- Needs a real Supabase to write against (task 007 blocker) and captured UAT
  payloads (task 008). Put sample payloads in `resources/`.
- Read [DATA-MODEL.md](../../../docs/DATA-MODEL.md) first: one human = one `person`,
  `text_login_type` never identifies a teacher.
- Update ARCHITECTURE (new files + module map) and DATA-MODEL in the same commit.

## Resources

- `resources/` — add WL sample payloads (staff, purchase list, receipt) as fixtures.
