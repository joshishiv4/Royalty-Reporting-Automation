# Progress: M03a-purchases — location, purchase, payment, service writer

## Checklist

- [ ] Settle the open question: which uids seed the purchase pull
- [ ] location/list → location parser + raw_link
- [ ] Derive payer person from purchase/receipt data
- [ ] purchase/payment/service parsers, FK-safe write order
- [ ] Idempotent upserts on natural keys; unit + live proof, mutation-verified

## Last step

Not yet started. Split from 010 on 2026-08-21.

## Blockers

Open question (purchase uid source) to settle first. Full client enumeration
remains blocked upstream; this task covers only payers it actually fetches.

## Log

### 2026-08-21
- Created by splitting the purchase path out of 010, which shipped the staff slice.
  Reason: FK ordering (location, payer person) + the per-client fetch shape are a
  separate sitting from the clean staff→person parser.

### 2026-08-21 — done
- src/sync/purchases.ts: parsePurchaseList (group items by k_purchase, dedupe by
  k_purchase_item, coerce id_*), writePurchaseList (raw -> location+service stubs ->
  purchase -> purchase_item -> raw_link). Money null (task 015).
- Wired runPurchaseSyncPass (seeds purchase_list per person.uid) by extracting a
  shared runPass shell from the staff pass.
- Live testing found + fixed two real queue bugs: (1) enqueue now sets
  next_attempt_at on the pass clock (was DB now() → claim clock skew stranded fresh
  items); (2) claimBatch filters by work_type (a purchase pass had claimed a
  leftover staff_list item and dead-lettered it).
- Live proof: staff pass ok, purchase pass ok claimed 20/done 20/dead 0, wrote 109
  purchases + 109 items across staff uids. Mutation-covered; npm run verify 256 green.
- Money + payment breakdown split to task 015.
