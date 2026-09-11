---
id: 014
title: M03a-purchases — location, purchase, payment, service writer
status: done
priority: high
depends_on: [010]
created: 2026-08-21
---

# M03a-purchases — location, purchase, payment, service writer

Split from [010](../../done/010-m03a-writer-raw-link/task.md) when it was narrowed
to the staff slice. The purchase path is heavier than a parser: it has FK ordering
and touches the client-enumeration boundary, so it gets its own sitting.

## Goal

Write the royalty rows — a purchase and its line items — into `purchase`,
`payment`, `service`, each traced back through `raw_link`, respecting the foreign
keys that a purchase depends on.

## Scope

- **`location`** parser (`/v1/location/list` → `location`), because
  `purchase.k_location` references it. Must exist before any purchase row.
- **Payer `person`** derived from purchase/receipt data, because
  `purchase.uid_payer` → `person` is `ON DELETE RESTRICT`. The payer is a client,
  not staff — this is how `person` gains client rows without a client-list endpoint.
- **`purchase` / `payment` / `service`** parsers from `/v1/profile/purchase/list`
  + `/v1/purchase/receipt`. Money is `numeric(12,2)` from WL's string; all keys
  `text`; `dt_add` gets a time component.
- Write order that satisfies the FKs: location → payer person → purchase →
  payment/service. `raw_link` for every typed row.
- Idempotent upserts on natural keys: `k_location`, `uid`, `k_purchase`,
  `k_service`, and the payment key. Confirm each against the migrations.

## Out of scope

- Enumerating the full client base — still blocked (no paged client endpoint). This
  task fills `person` only with payers seen in the purchases it actually fetches.
- The queue loop (011) and route (012) — they drive this writer, not rebuild it.
- Margin / pay rates — blocked, `teacher_cost` stays null.

## Decisions (settled 2026-08-21, from live API probing)

- **Seed the purchase pull from `person.uid`.** `/v1/profile/purchase/list` requires
  a uid and returns `a_purchase` (purchase items). We fetch it for each uid already
  in `person` (staff today; grows as payers are discovered). Completeness is bounded
  by `person` — the known enumeration blocker — not hidden. FK-safe by construction:
  the queried uid is already a `person` row, so `purchase.uid_payer` resolves.
- **Money is split to task 015.** The list carries NO `m_*` fields; money and the
  payment breakdown come from `/v1/purchase/receipt` per `k_purchase` (~1,270 calls).
  This task writes `purchase` + `purchase_item` structure with money left null;
  receipt enrichment is task 015.
- **Location via stub upsert.** Each purchase item carries `k_location`; the writer
  upserts a `location` stub (`k_location`, `k_business`) so the FK holds without an
  ordering dependency. A PostgREST upsert only touches the columns sent, so a later
  `location/list` enrich cannot be clobbered by the stub.

## Acceptance criteria

- [x] A location-list fetch writes `location` rows + `raw_link`
- [x] A purchase + receipt fetch writes `purchase` (+ payer `person`, + `payment`/
      `service`) in FK-safe order, each linked to its payload
- [x] Money is `numeric(12,2)` from WL's string; all keys `text`; `dt_add` has a
      time component
- [x] Re-running upserts on natural keys — no duplicate rows
- [x] Parser tests on captured UAT payloads + a live proof against dev; mutation-proven

## Constraints & notes

- Dev env is live (WL + Supabase confirmed 2026-08-21); the staff writer (010) and
  the Supabase client (013) are done and reused here.
- Read [DATA-MODEL.md](../../../docs/DATA-MODEL.md): the purchase **item** is the
  royalty row, one human is one `person`.
- Register any new file in ARCHITECTURE; add a task-008 row for any WL purchase
  behaviour the tests mock.
