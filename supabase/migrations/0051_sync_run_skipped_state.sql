-- =============================================================================
-- 0051  'skipped' joins sync_run's allowed states
--
-- THE BUG.
--   0035 gave every job a lease, and a run that finds the lease taken stands
--   down: runPass() closes its sync_run row with state = 'skipped' (pass.ts,
--   "TAKE THE JOB'S LEASE, OR STAND DOWN"). But the constraint was last
--   rebuilt by 0033, which allows
--
--     running, ok, partial, failed, cancelled, abandoned
--
--   and not 'skipped'. So the close is REJECTED (23514) every time. The row
--   stays 'running' with a heartbeat that never moves, and the 0033 sweep later
--   retires it as 'abandoned', which reports a died process for a run that
--   correctly did nothing.
--
--   Not one 'skipped' row has ever been stored. Seen on 1 Oct 2026: a sync was
--   stopped at 12:29:46 UTC while it held purchase_element_sync; the next one
--   started 16 seconds later, found the lease still valid, and stood down. Run
--   82308f54 stayed 'running' with heartbeat = started_at and no error. The
--   stand-down itself was right; only recording it failed.
--
-- WHY 'skipped' IS ITS OWN STATE.
--   The job is running elsewhere, which is not a failure, not a cancellation and
--   not a death. The digest counts 'failed' and the overdue check counts 'ok', so
--   'skipped' moves neither, which is the point: a cron overlapping a manual
--   backfill must not page anybody.
--
-- Dropped and recreated because a check constraint cannot be widened in place
-- (the same shape as 0033).
--
-- Safe to re-run.
-- =============================================================================

alter table public.sync_run
  drop constraint if exists sync_run_state_check;

alter table public.sync_run
  add constraint sync_run_state_check
  check (state in ('running', 'ok', 'partial', 'failed', 'skipped', 'cancelled', 'abandoned'));

-- No backfill. A stand-down that failed to record looks exactly like a process
-- that died, and nothing in the row tells the two apart, so the sweep's
-- 'abandoned' is left as it is rather than guessed at.
