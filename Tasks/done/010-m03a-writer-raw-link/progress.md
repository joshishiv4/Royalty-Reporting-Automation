# Progress: M03a — writer and raw_link for staff and purchases

## Checklist

- [ ] Confirm each typed table's unique constraint in the migrations
- [ ] Write raw_wl + parse staff/list → person + raw_link
- [ ] Parse purchase/list + receipt → purchase/payment/service rows
- [ ] Prove idempotent upsert on natural keys

## Last step

Not yet started.

## Blockers

None on access — dev env is live (healthcheck green 2026-08-21): WL auth + fetch
and Supabase REST all confirmed, all 8 tables present. Blocked only on the task(s)
in depends_on landing first.

## Log

### 2026-08-21
- Created as an M03 sub-task when PRD 009 was green-lit. Decisions live in 009.

### 2026-08-21 — done (staff slice)
- src/sync/writer.ts: storeRawWl + parseStaffList + writeStaffList + raw_link.
- 5 unit tests (pure parser + orchestration with a fake db) + live proof against dev:
  fetched 20 staff, wrote raw_wl + 20 person + 20 raw_link, k_staff set, cleanup 204.
- PersonRow is a type (not interface) so it satisfies the client's Record row input.
- Registered in ARCHITECTURE. npm run verify: 233 tests green.
- Purchase/payment/service path split to task 014 (FK ordering + client enumeration).
