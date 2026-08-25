# Progress: P6.2 — membership and refund detail on the purchase item

## Checklist

- [x] Probe which endpoint actually carries the fields; record in WL-API-NOTES
- [x] Migration `0013` — membership + refund columns on `purchase_item`
- [x] `parseMembership` + `writeMembership` (merge, never clobber; upsert on item)
- [x] Element pass seeds every item; second typed write off the shared raw row
- [x] Tests, mutation-proven
- [x] **Apply `0013` to the dev database** — manual, Supabase SQL editor
- [x] Live proof against dev

## Last step

Done. 109/109 items carry membership detail; the multi-item question is now
measured rather than assumed.

## Blockers

None. `0013` was applied to dev 24 Aug 2026 and the pass has run clean since.

## Log

### 2026-08-24 — code complete, migration pending

- **Corrected the board's premise.** 6.2 says the membership and refund fields
  come from `/v1/profile/purchase/list`. Probed live over 109 items: that
  endpoint returns EIGHTEEN fields, all identity, and not one of them is a
  membership or refund field. Every field 6.2 names is on
  `/v1/profile/purchase/list/element` — which the element pass (task 021)
  already calls once per purchase item and from which it kept four fields of
  eighty-seven. So the detail costs **no additional API call**.
- Migration `0013`: `sid_value`, `i_payment_period`, `m_period_price`, `is_hold`,
  `dt_hold_start`, `dt_hold_end`, `is_cancel_pending`, `dt_cancel`, `is_renew`,
  `i_renew`, `m_refund`, plus a partial index on the non-appointment rows.
- `src/sync/memberships.ts`: parse + upsert on `k_purchase_item`, reusing the
  `raw_wl` row `writeRecipient` already stored (one payload, one raw row, two
  typed writes). WL's `""`/`0` read as null and OMITTED, so a refresh cannot
  blank a stored value; the three booleans are always written because WL sends a
  real boolean and `false` is an answer.
- **`m_refund` trap:** WL's no-refund marker is the string `"0"` — not `"0.00"`,
  not `""`. A truthiness check would store a zero refund against every
  unrefunded item in the business. A real refund arrives NEGATIVE.
- Pass renamed `recipient_sync` → `purchase_element_sync`: it now takes two
  things from one payload, and the old name was a lie. It also seeds EVERY
  purchase item rather than only unattributed ones — a recipient never changes,
  membership state does, so the detail needs refresh semantics or it is captured
  once and rots. Safe: the recipient write is fill-only and a re-fetched
  agreeing item is a no-op.
- 15 tests; mutation-proven — dropping the `m_refund` `"0"` guard turns 3 red,
  mapping empty fields to null instead of omitting turns 4 red, and letting
  `readInt` keep `0` turns 2 red. All restored green.
- Live population measured over 109 dev items, recorded in the task and
  WL-API-NOTES. `is_hold`, both hold dates, `is_cancel_pending` and `can_renew`
  were **0/109** — written and tested, never observed live. Same for the
  multi-item purchase: dev is a strict 109 purchases / 109 items. Both belong in
  the task 008 ledger.

## Notes for whoever applies the migration

Two side effects to expect on the first run after `0013` lands:

- `sync_job_state` keeps an orphaned `recipient_sync` row from before the
  rename; the pass now writes `purchase_element_sync`. Harmless, but it will
  look like a stalled job until someone deletes it.
- The pass now makes one element call per purchase item every run (109 on dev),
  where it previously made none once every purchase was attributed. That is the
  deliberate cost of keeping membership state fresh.

### 2026-08-24 — migration applied, proven live, task closed

- `0013` applied to dev. All eleven columns present.
- Three consecutive full passes over every purchase item: **claimed 327 / done
  327 / requeued 0 / dead 0**. `purchase_item` held at 109 rows throughout and
  every captured value survived all three runs — refresh, never a duplicate, and
  merge-never-clobber doing its job.
- Captured live: `sid_value` 109/109, `i_payment_period` 11, `m_period_price` 11,
  `dt_cancel` 10, `is_renew` 9, `m_refund` 5. Types: `appointment` x91,
  `service-membership` x11, `service-limit` x6, `class-period` x1.
- Refunds, all negative as WL sends them: -280.00, -329.00, -230.00, -70.00,
  -42.50. The other 104 items read as null rather than 0.00, which is the `"0"`
  marker guard working on real data.
- Two design calls confirmed against live rows: item 181117945 is a membership
  with `m_period_price` **0.00** and a payment period (a zero price is real, and
  is kept), and items 181117945 / 181866830 are set to renew with `i_renew`
  **null** (WL sent 0, meaning "not yet renewed" - storing it would claim a
  renewal count the membership does not have).

### 2026-08-24 — the multi-item question, now measured

The one criterion that could not be shown live. Rather than leave it as "dev
happens to have none", it was measured from three independent angles:

- **Purchase list**, all 20 people: 109 purchases, 109 items.
- **Receipt, every one of the 109 purchases**: `a_purchase_item` held exactly
  ONE entry in all 109. Zero failures.
- **Element `a_component`** (WL's own "related component items"): empty on 60/60.
- No `k_purchase` appears under more than one uid.

And the cross-check that matters: WL offers 109 items, we store 109 rows across
109 purchases. **Nothing is being collapsed or lost** - if the code were keying
on `k_purchase` the receipt scan would show more items than we hold, and it does
not.

So the 1:1 is a fact about this business's data, not a defect. The criterion
stays mock-verified, and the task 008 ledger entry should say what would settle
it: a genuine multi-item purchase created in WL. Ten minutes of setup, not a
code change.
