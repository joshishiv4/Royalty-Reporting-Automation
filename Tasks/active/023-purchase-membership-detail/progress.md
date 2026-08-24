# Progress: P6.2 — membership and refund detail on the purchase item

## Checklist

- [x] Probe which endpoint actually carries the fields; record in WL-API-NOTES
- [x] Migration `0013` — membership + refund columns on `purchase_item`
- [x] `parseMembership` + `writeMembership` (merge, never clobber; upsert on item)
- [x] Element pass seeds every item; second typed write off the shared raw row
- [x] Tests, mutation-proven
- [ ] **Apply `0013` to the dev database** — manual, Supabase SQL editor
- [ ] Live proof against dev (blocked on the line above)

## Last step

Code complete and green: `npm run verify` = 33 files, 325 tests.

Blocked on one manual step: migration `0013` has not been applied to dev. There
is no way to run DDL from here — PostgREST exposes no `exec_sql` RPC (checked,
404), and migrations in this project have always been applied by hand in the
Supabase SQL editor (see task 007 and STATUS). Confirmed the columns are absent
live: `column purchase_item.sid_value does not exist`.

Until it is applied, the element pass will dead-letter every item — the upsert
names columns the table does not have.

## Blockers

1. **`0013` not applied to dev.** Manual step, needs a human with SQL-editor
   access. Everything else is done and proven by test.

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
