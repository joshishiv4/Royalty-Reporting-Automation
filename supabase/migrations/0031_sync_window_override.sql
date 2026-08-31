-- =============================================================================
-- 0031  sync_job_state.window_start_override / window_end_override
--
-- A one-shot manual window for a sync, so a human can say "go and fetch March
-- 2023 again" without editing code, redeploying, or hand-writing a script.
--
-- -----------------------------------------------------------------------------
-- WHY THIS IS AN OVERRIDE AND NOT THE CURSOR ITSELF
-- -----------------------------------------------------------------------------
-- The obvious design is to store the window and advance it after each run:
-- start = last end, end = now. It is also the design that loses data silently.
--
-- A pass here ends `partial` as a matter of course - a Vercel function is capped
-- at 60 seconds while a full sync is budgeted in hours, so "budget expired, work
-- still queued" is the NORMAL ending. If the stored start advanced on that, every
-- interrupted run would move the floor past work it never did, and the gap would
-- never be revisited or reported. That is precisely why
-- `last_clean_completion_at` moves only on a clean drain (0007), and why the
-- window is DERIVED from it rather than stored:
--
--   no clean completion  ->  SYNC_HISTORY_START .. now      (still a backfill)
--   a clean completion   ->  now - lookback .. now          (the daily overlap)
--
-- Derived, that rule is self-correcting: an interrupted backfill still looks like
-- a backfill next time. Stored, it would be self-deceiving.
--
-- So these two columns do NOT replace that. They sit beside it and win when set.
--
-- -----------------------------------------------------------------------------
-- CLEARED ON A CLEAN DRAIN, NOT ON READ
-- -----------------------------------------------------------------------------
-- Clearing at read time would lose the override the first time a run crashed
-- before doing the work - the request would be accepted, then silently forgotten.
-- Clearing on `ok` means the override survives exactly as long as it takes to be
-- honoured, which is the same rule the watermark already follows.
--
-- It clears rather than persists deliberately. A standing override is a footgun:
-- somebody sets 1980 to repair one gap, forgets, and every nightly run afterwards
-- re-fetches the entire history at full cost while looking perfectly healthy.
-- One shot, then back to the derived rule.
--
-- -----------------------------------------------------------------------------
-- timestamptz, NOT text
-- -----------------------------------------------------------------------------
-- WellnessLiving wants `YYYY-MM-DD HH:MM:SS` and rejects a bare date, but that is
-- a formatting concern at the edge (src/sync/visit-window.ts owns it). Storing
-- the wire format here would make the column unqueryable and let an invalid date
-- sit in the table until a sync tripped over it. The database checks it on write.
--
-- Safe to re-run.
-- =============================================================================

alter table public.sync_job_state
  add column if not exists window_start_override timestamptz,
  add column if not exists window_end_override   timestamptz;

comment on column public.sync_job_state.window_start_override is
  'One-shot manual floor for this job''s next sync window, in UTC. Null means '
  'use the derived rule (SYNC_HISTORY_START until a clean drain, then the daily '
  'lookback). CLEARED AUTOMATICALLY when a pass drains cleanly - a standing '
  'override would make every nightly run re-fetch the same range forever while '
  'reporting success. Set it again whenever a specific range needs re-reading.';

comment on column public.sync_job_state.window_end_override is
  'One-shot manual ceiling, in UTC. Null with a start override set means "from '
  'there to now". Cleared with its partner on a clean drain.';

-- A window that ends before it starts fetches nothing and reports success, which
-- is the quietest possible way to waste a run. Refuse it at the door.
alter table public.sync_job_state
  drop constraint if exists sync_job_state_window_order;
alter table public.sync_job_state
  add constraint sync_job_state_window_order
  check (
    window_start_override is null
    or window_end_override is null
    or window_start_override < window_end_override
  );

-- What is pending a manual window, for anyone wondering why a run behaved oddly.
create or replace view public.sync_window_override as
  select job_name,
         k_business,
         state,
         window_start_override,
         window_end_override,
         last_clean_completion_at,
         last_seen_at
  from public.sync_job_state
  where window_start_override is not null
     or window_end_override is not null;

comment on view public.sync_window_override is
  'Jobs carrying a one-shot manual sync window. Normally EMPTY: an override is '
  'consumed by the next clean drain. A row that persists means the job has not '
  'completed cleanly since the override was set - which is information, not a '
  'fault.';

alter view public.sync_window_override set (security_invoker = on);
