-- =============================================================================
-- 0035  A lease on sync_job_state, so two runs of one job cannot overlap
--
-- =============================================================================
-- THIS IS NOT HYPOTHETICAL. IT HAS ALREADY COST US.
-- =============================================================================
-- sync_run on 31 Aug 2026:
--
--   06:32:36   client_session_sync   running   (never closed - the process died)
--   08:14:26   client_session_sync   ok        (a second run, while the first
--                                               was still believed alive)
--
-- Two runs of one pass overlapped. One drained rows pending -> done while the
-- other was paging enqueue's dedupe read; that read skipped rows, and the insert
-- collided:
--
--   23505: duplicate key value violates unique constraint
--          "sync_queue_active_target_key"
--
-- It killed attendance_sync outright and left 32,440 items unqueued. Migration
-- 0032 made the WRITE survive that race. This stops the race happening.
--
-- =============================================================================
-- WHY A LEASE AND NOT A BOOLEAN
-- =============================================================================
-- `state = 'running'` already exists on this table and is useless as a lock: the
-- process that sets it is the only thing that clears it, so a process that dies
-- locks its job FOREVER. Forty runs sat open on live dev, the oldest ten days.
--
-- A lease expires on its own. Exactly the shape of sync_queue.claim_expires_at
-- and sync_run.heartbeat_at (0033) - the same problem, the same answer, and
-- deliberately not a third invention.
--
-- =============================================================================
-- WHY THE LOCK IS TAKEN BY A CONDITIONAL UPDATE
-- =============================================================================
-- Read-then-write cannot lock anything: two callers both read "free" and both
-- proceed. The acquire is therefore a single UPDATE whose WHERE clause carries
-- the condition, and PostgREST returns the rows it changed - one row means the
-- lock is ours, zero means somebody else has it. Postgres decides, not us.
-- The same compare-and-swap claimBatch already uses for queue items.
--
-- Safe to re-run.
-- =============================================================================

alter table public.sync_job_state
  add column if not exists locked_until timestamptz,
  add column if not exists locked_by    text;

comment on column public.sync_job_state.locked_until is
  'Lease expiry. A run holds its job until this moment; past it, another run may '
  'take over. Expiry is what stops a died process locking its job forever - '
  'state = ''running'' cannot do that, because only the dead process would clear it.';
comment on column public.sync_job_state.locked_by is
  'The run_id holding the lease, so an overlap that does happen names the culprit.';

-- The acquire filters on (job_name, k_business) - already the primary key - and
-- reads locked_until. Nothing else to index.

-- -----------------------------------------------------------------------------
-- Clear any lease left over from before this column existed.
--
-- There cannot be one, since nothing has ever set it. Written anyway because a
-- migration that assumes its own starting state is how a re-run on a database
-- somebody has poked at goes wrong.
-- -----------------------------------------------------------------------------
update public.sync_job_state
   set locked_until = null,
       locked_by    = null
 where locked_until is not null;
