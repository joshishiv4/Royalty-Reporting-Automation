---
id: 023
title: P6.2 — membership and refund detail on the purchase item
status: done
priority: high
depends_on: [014, 021]
created: 2026-08-24
---

# P6.2 — membership and refund detail on the purchase item

Board item 6.2. The purchase list itself already lands (task 014): pulled per
client, upserted on `k_purchase_item`, no duplicates on a re-run. What is missing
is the membership and refund detail the board asks for.

## Context, and a correction to the board wording

6.2 says the fields come from the purchase list. **They do not.** Probed live
24 Aug 2026 across 109 items: `/v1/profile/purchase/list` returns eighteen fields
and not one of them is a membership or refund field.

Every field 6.2 names is on `/v1/profile/purchase/list/element` (87 fields) —
the endpoint `recipient_sync` (task 021) **already calls once per purchase item**
and from which it currently keeps four fields. So the detail costs no new API
call; it is already being fetched and thrown away.

## Goal

Capture membership state and the refund amount on `purchase_item`, from the
element payload the element pass already holds.

## Scope

- Migration `0013`: membership + refund columns on `purchase_item`.
- `src/sync/memberships.ts` — parse the element payload into a `purchase_item`
  patch and upsert it, reusing the `raw_wl` row the recipient write already
  stored (one payload, one raw row, two typed writes).
- The element pass seeds **every** purchase item, not only unattributed ones.
  Membership state changes over time — a hold starts, a cancellation goes
  pending — so it needs refresh semantics. The recipient write is fill-only and
  conflict-parking, so re-fetching an attributed item stays a no-op.
- Rename the pass to `purchase_element_sync`: it no longer only does recipients.

## Fields, with live population over 109 dev items

| 6.2 asks for | WL field | Type | Populated |
|---|---|---|---|
| Payment period | `i_payment_period` | number | 11 |
| Period price | `m_period_price` | money string | 11 |
| Hold state | `is_hold` | boolean | 0 |
| Hold dates | `dt_hold_start` / `dt_hold_end` | datetime | 0 |
| Pending cancellation | `is_cancel_pending` | boolean | 0 |
| Cancellation date | `dt_cancel` | datetime | 10 |
| Renewal | `is_renew` / `i_renew` | boolean / number | 9 / 3 |
| Refund | `m_refund` | money string | 5 |

Also captured: `sid_value` — the purchase type (`appointment` ×91,
`service-membership` ×11, `service-limit` ×6, `class-period` ×1). Without it
nothing on the row says *whether* it is a membership, which is what makes the
membership columns readable.

## Out of scope

- `dl_cancel` — the local-date twin of `dt_cancel`, and 0/109 populated where
  `dt_cancel` had 10. Purchases store UTC only (ARCHITECTURE conventions).
- The other ~70 element fields (component lists, logos, tax, gift, discounts).

## Acceptance criteria

- [x] Purchase list pulled per client and upserted on the purchase item
      (already true from 014 — proven, not re-built)
- [x] A purchase containing several items produces several rows (structural —
      the key is `k_purchase_item`; mock-verified, dev is a strict 1:1)
- [x] Membership fields captured where present: payment period, period price,
      hold state and hold dates, pending cancellation and renewal
- [x] Refund amount captured where present
- [x] Re-running produces no duplicates

## Constraints & notes

- **`m_refund` is `"0"` when there is no refund** — not `"0.00"`, not `""`. A
  real refund arrives negative (`"-280.00"`). Read `"0"` as "no refund".
- WL's `""` is read as null and the column omitted, so a refresh cannot blank a
  value another source set — the same merge rule as 022.
- **Cannot be proven live on dev:** `is_hold`, both hold dates, `is_cancel_pending`
  and `can_renew` were 0/109. The columns write, but the populated path is
  mock-verified only — goes in the task 008 ledger.
- **Cannot be proven live on dev:** dev has 109 purchases and 109 items, a strict
  1:1. The multi-item case is structural (the key is `k_purchase_item`) and
  mock-verified only — also task 008.
