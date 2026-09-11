---
id: 015
title: Purchase receipt enrichment — money and the payment breakdown
status: done
priority: high
depends_on: [014]
created: 2026-08-21
---

# Purchase receipt enrichment — money and the payment breakdown

Split from 014, which wrote purchase + purchase_item structure with money null.
This task fills the money.

## Goal

Populate the `m_*` totals on `purchase` and `purchase_item`, and the
`purchase_payment` method breakdown, from `/v1/purchase/receipt` — one call per
`k_purchase`. This is the ~1,270-call fan-out (STATUS reference numbers).

## Scope

- A `purchase_receipt` queue work type, seeded from `purchase.k_purchase` rows that
  still have `m_total IS NULL` (the ones 014 wrote without money).
- Fetch `/v1/purchase/receipt` per k_purchase; parse and UPDATE (not re-insert):
  `purchase.m_sum/m_discount/m_tax/m_tip/m_total/text_currency`, and each
  `purchase_item.m_price_total`.
- `purchase_payment` rows from `a_pay_method` (the payment-method breakdown), and
  `purchase_account_credit` where a payment was drawn from credit (a negative
  balance is NOT a payment — see DATA-MODEL, migration 0002).
- Money is `numeric(12,2)` from WL's STRING — never float. Store as string.
- `raw_link` each row to the receipt payload.

## Out of scope

- The list-level purchase/item structure (task 014, done).
- Margin / teacher_cost — still blocked (no pay amounts).

## Open question to settle first

- **Probe the receipt shape live** before coding: confirm where the totals and the
  `a_pay_method` breakdown sit in `/v1/purchase/receipt`, and how account-credit
  payments present. Record findings in docs/WL-API-NOTES.md.

## Acceptance criteria

- [x] A receipt fetch updates its purchase's `m_total` (and the other m_* fields)
      and each item's `m_price_total`, as `numeric(12,2)` from WL's string
- [x] `purchase_payment` rows written from the method breakdown; account-credit
      handled distinctly from a payment
- [x] Re-running updates in place — no duplicate payment rows
- [x] Parser tests on a captured receipt payload + a live proof against dev
- [x] A task-008 row for any receipt behaviour the tests mock

## Constraints & notes

- Dev is live; 013/014 (Supabase client, purchase writer) are done and reused.
- Seed from purchases missing money so a re-run enriches only what is unpriced.
- The queue and pass infrastructure (011/012) already supports a new work type —
  add a `runReceiptSyncPass` mirroring `runPurchaseSyncPass`.
