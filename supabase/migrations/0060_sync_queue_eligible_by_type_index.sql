-- =============================================================================
-- 0060  sync_queue (work_type, next_attempt_at) where state = 'pending'
--       the index countEligible has been missing since 0007
--
-- WHAT RAN WITHOUT AN INDEX
-- -----------------------------------------------------------------------------
-- countEligible (src/sync/pass.ts) ends every pass with
--
--   state = 'pending' and work_type = ? and next_attempt_at <= ?
--
-- and until now nothing indexed that shape. `sync_queue_claimable_idx` (0007) is
-- on (next_attempt_at) where state = 'pending' - no work_type - so the predicate
-- could only be met by filtering, and `sync_queue_fresh_done_idx` (0050) covers
-- state = 'done', a different partial index this query cannot use.
--
-- Measured 9 Oct 2026 against an IDLE database, every one of them returning no
-- rows at all:
--
--   purchase_item_element   399,140 queued   2,638 ms
--   client_visits            27,178 queued     849 ms
--   session_attendance      802,779 queued     697 ms
--
-- 2.6 seconds to find nothing. Under a pass - WL writes in flight, the same
-- table being claimed and settled - that is what reached the statement timeout:
-- purchase_element_sync, 9 Oct 11:19:08Z, `57014: canceling statement due to
-- statement timeout`, AFTER its queue had drained to 399,140 done at 11:09:57.
--
-- WHY THIS INDEX AND NOT A WIDER ONE
-- -----------------------------------------------------------------------------
-- Partial on state = 'pending' for the same reason 0007's is: a drained queue
-- has no pending rows, so the index is near-empty exactly when the table is at
-- its largest. work_type leads because it is the equality; next_attempt_at
-- follows as the range. k_business is deliberately absent - countEligible does
-- not filter on it, and an unused trailing column is width every insert pays for.
--
-- Not a replacement for sync_queue_claimable_idx. The claim query orders by
-- next_attempt_at across ALL work types and still wants that one.
--
-- Safe to re-run.
-- =============================================================================

create index if not exists sync_queue_eligible_by_type_idx
  on public.sync_queue (work_type, next_attempt_at)
  where state = 'pending';

comment on index public.sync_queue_eligible_by_type_idx is
  'countEligible: pending work of one type that is due now. Partial on pending '
  'so a drained queue carries almost no index. Added after a 57014 statement '
  'timeout on the 399,140-row purchase_item_element queue cost a completed pass '
  'its run record, 9 Oct 2026.';
