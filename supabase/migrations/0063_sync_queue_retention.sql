-- =============================================================================
-- 0063  prune_sync_queue - a retention window for sync_queue's done rows
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------------------------
-- sync_queue has never been pruned, and its size is now the single most common
-- cause of a failed pass. Measured:
--
--   23 Sep 2026    532,415 rows, 532,412 done   claim/enqueue 1.3-2.0 s each
--   30 Sep 2026                                 one read killed 16 of 18 passes
--    1 Oct 2026    869,798 rows, 823,322 done   0050 indexed that read
--   13 Oct 2026  1,506,074 done                 count(*) CANCELLED after 10,141 ms
--
-- On 13 Oct 2026 attendance_sync failed with `57014: canceling statement due to
-- statement timeout [table=enqueue_sync_items]` - the INSERT itself, not the read
-- 0050 fixed - leaving 3,500 session_attendance items unqueued. Counting the
-- 3,500 pending rows through a partial index took 1,055 ms.
--
-- Two indexes have been added against this table's growth (0050, 0060) and each
-- one moved the bottleneck rather than removing it. STATUS.md has carried the
-- real fix since 23 Sep: a retention window plus a scheduled cleanup.
--
-- THE 24-HOUR FLOOR, WHICH IS WHY THIS TAKES A PARAMETER
-- -----------------------------------------------------------------------------
-- `enqueue()` decides whether a target was already refreshed today by reading
-- `state = 'done' and updated_at >= now() - 24h` (DEFAULT_FRESH_DONE_WINDOW_MS,
-- src/sync/queue.ts). Delete inside that window and the dedupe goes blind: it
-- stops seeing today's completions and re-queues work the same day, trading a
-- size problem for a correctness one.
--
-- So the cutoff is the caller's, not this function's, and the caller is expected
-- to stay well clear of 24 hours. The service uses 20 days. A done row older than
-- that has no reader at all: the dedupe cannot see it, and both the claim and
-- countEligible filter on `pending`.
--
-- WHY A LIMIT, AND WHY ctid
-- -----------------------------------------------------------------------------
-- One DELETE of 1.5M rows would hit the very statement timeout this exists to
-- fix, and would hold locks on a table seventeen passes are working. The caller
-- loops in batches instead; each statement stays short enough to finish.
--
-- `ctid in (select ... limit n)` rather than a predicate alone, because a bare
-- DELETE ... LIMIT is not SQL and ordering by a column would make the planner
-- sort a million rows to delete ten thousand of them. The subquery takes
-- whatever rows it finds first; which ones go in this batch does not matter when
-- the loop takes them all.
--
-- ONLY `done`. Never a pending, in_progress, failed or dead row: those are either
-- outstanding work or the record of why something was given up on, which is the
-- first thing an operator reads at 2am.
--
-- Safe to re-run.
-- =============================================================================

create or replace function public.prune_sync_queue(
  p_before timestamptz,
  p_limit  integer default 5000
)
returns integer
language sql
security invoker
as $$
  with doomed as (
    delete from public.sync_queue
     where ctid in (
       select ctid
         from public.sync_queue
        where state = 'done'
          and updated_at < p_before
        limit greatest(p_limit, 0)
     )
    returning 1
  )
  select coalesce(count(*), 0)::integer from doomed;
$$;

comment on function public.prune_sync_queue(timestamptz, integer) is
  'Deletes at most p_limit sync_queue rows that are done and older than p_before, '
  'returning how many went. Batched because one DELETE over 1.5M rows hits the '
  'statement timeout it exists to prevent. The caller owns the cutoff and must '
  'stay clear of the 24h fresh-done dedupe window (src/sync/queue.ts); the '
  'service uses 20 days. Never touches pending, in_progress, failed or dead.';
