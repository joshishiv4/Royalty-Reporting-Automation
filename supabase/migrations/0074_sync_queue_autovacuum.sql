-- =============================================================================
-- 0074  sync_queue is vacuumed by its churn, not by a fifth of its size
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------------------------
-- 0073 bounded the ROW COUNT. It did not make the table fast. Measured 27 Nov
-- 2026, the day after 0073's prune took sync_queue from 713,690 rows to ~172,000
-- (157,121 done, 15,000 pending, 0 dead; sync_queue_estimated_rows() = 172,121):
--
--   count of the whole table              cancelled, ~9 s (HTTP 500)
--   count of session_attendance, done     97,302 rows in 7,064 ms
--   enqueue_sync_items, 500 rows          seconds each: 30 chunks (15,000 rows)
--                                         went in during a 128 s seed before the
--                                         31st was cancelled
--
-- and the hourly sync of 26 Nov 23:39 UTC (Actions run 45912241531) failed in
-- attendance_sync with
--
--   SupabaseError: 57014: canceling statement due to statement timeout
--     [table=enqueue_sync_items]
--
-- A table of 172,000 rows does not take nine seconds to count. One that still
-- occupies the space of the 1.5 million it used to hold does: DELETE and a plain
-- VACUUM make the space reusable, they do not give it back, and every index
-- keeps its old size too. This is the question task 035 left open on 13 Oct -
-- "if the slowness is bloat rather than row count" - answered by the timings
-- above. (Answered by timings, NOT by pg_stat: n_dead_tup and the relation size
-- were not readable through PostgREST when this was written.
-- supabase/checks/sync_queue_bloat.sql reads them.)
--
-- WHAT THIS DOES NOT DO, AND WHAT DOES IT
-- -----------------------------------------------------------------------------
-- It does not reclaim the space already lost. That is one statement, run by hand
-- from a SQL console with no `sync` run in progress, because it takes an
-- exclusive lock while it rewrites the table and every index:
--
--   vacuum (full, analyze) public.sync_queue;
--
-- It cannot live in a migration: VACUUM cannot run inside a transaction block.
-- RUNBOOK section 8h has the procedure.
--
-- This migration is what stops it coming back.
--
-- WHY THE DEFAULTS ARE WRONG FOR A QUEUE
-- -----------------------------------------------------------------------------
-- Autovacuum starts on a table when its dead rows pass
--
--   autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * rows
--
-- and Postgres ships 50 + 0.2 * rows (the stock defaults; this instance's own
-- values were not read - the check script prints them). That is sized for a
-- table whose rows mostly stay put. Every sync_queue row is rewritten at least
-- twice and then deleted - pending -> in_progress -> done -> pruned - and none of
-- those updates can be heap-only, because `state` is in the predicate of every
-- partial index on the table. So one queue item leaves about three dead row
-- versions, each with its own dead index entries: ~58,000 items a day (0073) is
-- ~175,000 dead versions a day.
--
-- Against 0.2 * rows:
--
--   at ~1.16M rows (26 Nov)   vacuum waits for ~232,000 dead versions - more than
--                             a day's worth
--   at ~172,000 rows          ~34,000 - and attendance_sync alone turns over
--                             more than 20,000 items in the hour it runs
--
-- A fixed, small trigger suits a table whose size is capped and whose churn is
-- the point:
--
--   vacuum   at 2,000 + 0.02 * rows   ~5,400 dead versions at 172,000 rows,
--                                      8,000 at the 300,000-row cap
--   analyze  at 2,000 + 0.02 * rows   the planner's picture of `state` goes
--                                      stale within one pass (20,000 rows move
--                                      pending -> done in an hour); the default
--                                      0.1 * rows waits for 17,000 changes
--
-- These numbers are ARITHMETIC, not a measurement. What settles whether they are
-- right is n_dead_tup staying in the low thousands after the one-off VACUUM FULL
-- - supabase/checks/sync_queue_bloat.sql, run a day later.
--
-- WHY NOT fillfactor. Lowering it leaves room for heap-only updates, and this
-- table can never have one (see above). It would only make the table bigger.
--
-- LOCKING. ALTER TABLE ... SET (storage parameters) takes SHARE UPDATE EXCLUSIVE:
-- reads and writes carry on. Unlike 0050 and 0073 this does not need the sync
-- idle.
--
-- Safe to re-run.
-- =============================================================================

alter table public.sync_queue set (
  autovacuum_vacuum_threshold     = 2000,
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_threshold    = 2000,
  autovacuum_analyze_scale_factor = 0.02
);

-- -----------------------------------------------------------------------------
-- Trailing check: refuse to finish if the settings did not land.
-- -----------------------------------------------------------------------------
do $$
declare
  opts text[];
begin
  select c.reloptions into opts
    from pg_catalog.pg_class c
   where c.oid = 'public.sync_queue'::regclass;

  if opts is null
     or not ('autovacuum_vacuum_threshold=2000' = any (opts))
     or not ('autovacuum_vacuum_scale_factor=0.02' = any (opts))
     or not ('autovacuum_analyze_threshold=2000' = any (opts))
     or not ('autovacuum_analyze_scale_factor=0.02' = any (opts)) then
    raise exception '0074: sync_queue autovacuum settings are missing: %', opts;
  end if;
end;
$$;
