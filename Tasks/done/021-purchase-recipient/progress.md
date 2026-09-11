# Progress: Purchase recipient — uid_recipient from the element endpoint

## Checklist

- [x] Probe /v1/profile/purchase/list/element live; record in WL-API-NOTES
- [x] parsePurchaseElement + writeRecipient (stub → fill-only → conflict)
- [x] purchase_item_element work type + runRecipientSyncPass, in full-sync order
- [x] Tests, mutation-proven; task-008 rows for mock-only paths
- [x] Live proof: seed, drain, idempotent re-run

## Last step

Done. 109/109 dev purchases attributed.

## Blockers

None. (The "no recipient source" blocker lived for a few hours as STATUS
blocker 4 on 24 Aug before the element endpoint resolved it.)

## Log

### 2026-08-24 — done
- The parent PRD criterion "payer and recipient both recorded" was half-met:
  uid_payer landed with 014, uid_recipient had no source. The WL Postman
  collection (bid-334942 v1.2026-07-22) documented uid_payer/uid_recipient on
  /v1/profile/purchase/list/element; probed live — uid_recipient present on every
  sample (string), uid_payer sometimes null, k_purchase not echoed. Recorded in
  WL-API-NOTES.
- src/sync/recipients.ts: parsePurchaseElement + writeRecipient. Person stub
  (uid + k_business only) upserted BEFORE the FK write; fill-only update;
  disagreement between items parks sync_conflict `recipient-differs-by-item`
  (guarded against duplicates while one is open) — the first real use of that
  table. runRecipientSyncPass seeds items via a PostgREST !inner embed filter on
  purchase.uid_recipient=is.null.
- 9 tests; mutation-proven (disabling the disagreement guard turns 2 red).
- Proven live: 30 + 40 + 39 items over three bounded passes (partial → partial →
  ok), 109/109 purchases attributed, 0 conflicts, 0 dead; a fourth run claimed 0
  (idempotent). All dev samples are self-purchases — the distinct-recipient and
  "0"-placeholder paths are mock-only, tracked in task 008.
