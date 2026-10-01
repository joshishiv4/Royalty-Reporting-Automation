-- =============================================================================
-- 0050  An index for enqueue()'s fresh-done read, the query that times out
--
-- THE FAILURE, MEASURED ON LIVE DEV.
--   Every pass starts by seeding, and seeding starts with enqueue()'s dedupe
--   (src/sync/queue.ts). Its second read asks: which of these targets finished
--   in the last 24 hours?
--
--     work_type in (...) and k_business in (...)
--       and state = 'done' and updated_at >= <now - 24h>
--     order by id limit 1000 offset N
--
--   No index covers it. 0007 indexed the ACTIVE states (pending, in_progress)
--   and the dead ones; `done` was never expected to be read, so it was never
--   indexed. Postgres walks the primary key in id order and filters every row
--   it passes - and `done` is 823,322 of the table's 869,798 rows, because
--   nothing has ever pruned it (STATUS.md, "sync_queue has never been pruned").
--
--   Timed one at a time on 1 Oct 2026, with no sync running:
--
--     client_visits        9,712 ms  -> 57014 statement timeout
--     promotion_list       8,634 ms  -> 57014
--     client_list          8,524 ms
--     login_type_list      8,481 ms  -> 57014
--     every other read     0.3 - 2 s   (claim, countEligible, active dedupe)
--
--   It is slowest exactly where it finds NOTHING: a work type with no fresh
--   `done` rows makes the id walk run the whole table before it can say so.
--   sync:full-parallel then starts eighteen passes in the same instant, so
--   eighteen of these queue up together. On 30 Sep 08:21 UTC sixteen of the
--   eighteen passes died this way 10-52 seconds in, before claiming a single
--   item - the "16 stage(s) crashed" digest. Repeated failures of
--   attendance_sync and purchase_element_sync are also what made the overdue
--   alert call them jobs that "did not run".
--
-- WHY THESE COLUMNS, IN THIS ORDER.
--   (work_type, k_business) are the equality filters and lead; updated_at is the
--   range and comes last, so one index range scan returns only the last 24
--   hours of one work type. Partial on state = 'done' because that is the only
--   state this read asks for, and it keeps the index off the active rows the
--   0007 indexes already serve.
--
--   Rejected: (work_type, k_business, id), which would satisfy the ORDER BY
--   without a sort. It would still visit every `done` row of the work type to
--   test updated_at - client_visits has years of them and none fresh, which is
--   the slow case reproduced in a smaller table. A sort of at most a day's rows
--   is cheaper.
--
-- THE INDEX NEEDS THE READ TO BE ORDERED BY updated_at.
--   Applied on its own, it fixed 15 of 17 work types but not
--   purchase_item_element (243,475 done, none fresh). That read still said
--   `order by id`, so the planner walked the primary key expecting 1000 early
--   matches, found none, and timed out; unordered it took 310 ms. enqueue()
--   now orders it by (updated_at, id), the order this index holds. Ordering it
--   by id again brings the timeout back, index or not.
--
-- WHAT THIS DOES NOT FIX.
--   The table still grows on every run. The index makes the read cheap
--   regardless of size, but the retention window and scheduled cleanup in
--   STATUS.md are still the real fix, and still unwritten.
--
-- WHY NOT CREATE INDEX CONCURRENTLY.
--   CONCURRENTLY cannot run in a transaction, and a failed concurrent build
--   leaves an INVALID index behind that `if not exists` then skips for ever -
--   this file would stop being safe to re-run. A plain build holds writes on
--   sync_queue only while it runs. Apply it while no sync is running (the
--   sync workflow in GitHub Actions is idle), so no pass is left waiting
--   behind the build.
--
-- Safe to re-run.
-- =============================================================================

-- The SQL editor's default statement timeout is the same one the sync hits. An
-- index build over ~870k rows should finish well inside it, but a timeout here
-- would roll the build back and look like nothing happened.
set statement_timeout = '10min';

create index if not exists sync_queue_fresh_done_idx
  on public.sync_queue (work_type, k_business, updated_at)
  where state = 'done';

comment on index public.sync_queue_fresh_done_idx is
  'enqueue() fresh-done dedupe: targets finished inside the window are not '
  're-queued. Without it the read scanned every done row and hit the '
  'statement timeout (0050).';

-- Fresh statistics, so the planner chooses the new index on the next seed
-- rather than the id walk it was choosing.
analyze public.sync_queue;

reset statement_timeout;

-- -----------------------------------------------------------------------------
-- To confirm it took, run this and look for "sync_queue_fresh_done_idx" in the
-- plan rather than "sync_queue_pkey":
--
--   explain
--   select work_type, target_key, k_business
--     from public.sync_queue
--    where work_type in ('client_visits') and state = 'done'
--      and updated_at >= now() - interval '24 hours'
--    order by id limit 1000;
-- -----------------------------------------------------------------------------
