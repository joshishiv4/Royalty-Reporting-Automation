---
id: 021
title: Purchase recipient — uid_recipient from the element endpoint
status: done
priority: high
depends_on: [014, 015]
created: 2026-08-24
---

# Purchase recipient — uid_recipient from the element endpoint

Closes the last gap in the parent PRD's "payer and recipient both recorded"
criterion. 014 wrote `uid_payer` (the purchase list is per-payer by construction);
015 wrote money and the printed payer details; nothing wrote `uid_recipient` —
briefly recorded as STATUS blocker 4, then unblocked the same day when the WL
Postman collection pointed at `/v1/profile/purchase/list/element` and a live probe
confirmed it.

## Goal

Populate `purchase.uid_recipient` from `/v1/profile/purchase/list/element` — one
call per `k_purchase_item` (the only endpoint that says who a purchase was FOR),
FK-safe even when the recipient is not an enumerable client yet.

## Scope

- A `purchase_item_element` queue work type, seeded from items whose purchase has
  `uid_recipient IS NULL` (PostgREST `!inner` embed filter), so a re-run enriches
  only the unattributed.
- Fetch the element per item; parse `uid_recipient`/`s_recipient` (uid `"0"` and
  `""` read as null — the `k_location "0"` convention).
- Fill-only write: person STUB (uid + k_business) upserted first so the FK holds;
  `purchase.uid_recipient` set only when null; an agreeing sibling item is a
  no-op; a DISAGREEING one parks a `sync_conflict`
  (`recipient-differs-by-item`) — never overwrites. First real use of
  `sync_conflict`.
- `raw_link` the purchase to the element payload (`field_group: recipient`).
- `runRecipientSyncPass` in the full-sync order after `receipt_sync`.

## Out of scope

- Element money fields (`m_cost_total` etc.) — the receipt stays the money source.
- Enriching the person stub (name split from `s_recipient` would be a guess).

## Acceptance criteria

- [x] Probe the element shape live before coding; record in WL-API-NOTES
- [x] `uid_recipient` filled for every purchase with items, FK intact
- [x] Disagreement between items parked as a sync_conflict, not overwritten
- [x] Re-running seeds nothing once every purchase is attributed
- [x] Parser + writer tests, mutation-proven; task-008 rows for the paths only
      mocks cover (distinct-recipient purchase, the "0" placeholder)

## Constraints & notes

- The element body does NOT echo `k_purchase`; the item row 014 wrote carries it.
- `uid_payer` on the element is sometimes null where `uid_recipient` never was —
  payer-absence must not be read as recipient-absence.
