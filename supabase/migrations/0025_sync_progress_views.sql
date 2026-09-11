-- =============================================================================
-- 0025  sync_queue_progress and ghl_match_progress - per-stage progress views
--
-- "How much of the pipeline is done, and how much is still pending" is a
-- question we answer against the durable queue (sync_queue) and against the
-- match verdict on person. Before this migration, that answer lived in ad-hoc
-- scratchpad scripts and in whatever the last CLI run printed. Two views make
-- it queryable from the SQL editor, from the portal later, and from any dev
-- checking the state of a running sync without touching the code.
--
-- WHY VIEWS AND NOT COUNTERS ON THE JOB TABLE
--   sync_job_state already tracks per-job lifecycle. It does NOT count queue
--   items - a job can complete after re-queuing everything, and a job can be
--   'partial' with plenty done. The queue is the source of truth for
--   per-work_type progress, and a view derives it fresh on every query so
--   nothing can go stale.
--
-- WHY GHL SITS IN ITS OWN VIEW
--   The GHL match verdict lives on person.ghl_match_state, not on the queue.
--   sync_queue tells you whether the search was attempted; ghl_match_state
--   tells you what the platform said. They answer different questions, so they
--   read from different sources - and forcing a join here would make the queue
--   view lie whenever a person exists that was never queued.
--
-- BOTH VIEWS ARE security_invoker so RLS still applies to the caller. Views
-- that bypass RLS are how a "read-only" screen quietly exposes another
-- business's counts.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sync_queue_progress: per-work_type snapshot of every state the queue tracks.
--
-- The row is a mini-histogram plus a %-done, per business. A "not-yet-seeded"
-- work_type is simply absent - the caller decides whether to display it as
-- "waiting" or to hide it. Padding a view with zero-rows would need a static
-- list of work_types here, and adding a new pass would then also need a
-- migration; the current sync's job registry is the authoritative list, and
-- this view happily reports whatever it finds.
-- -----------------------------------------------------------------------------
drop view if exists public.sync_queue_progress;

create view public.sync_queue_progress
  with (security_invoker = on) as
  select
    k_business,
    work_type,
    count(*) filter (where state = 'pending')     as pending,
    count(*) filter (where state = 'in_progress') as in_progress,
    count(*) filter (where state = 'done')        as done,
    count(*) filter (where state = 'failed')      as failed,
    count(*) filter (where state = 'dead')        as dead,
    count(*)                                       as total,
    -- Rounded percent, integer so the display is stable and readable. A queue
    -- with zero rows returns NULL rather than dividing by zero: NULL reads as
    -- "no data yet", which is honest; 0% would read as "started and got
    -- nowhere", which is not.
    case when count(*) = 0 then null
         else round(100.0 * count(*) filter (where state = 'done') / count(*))
    end as pct_done,
    min(created_at) filter (where state in ('pending','in_progress')) as oldest_unfinished,
    max(updated_at) as most_recent_change
  from public.sync_queue
  group by k_business, work_type;

comment on view public.sync_queue_progress is
  'Per-work_type queue histogram (pending/in_progress/done/failed/dead) with '
  '%-done and freshness. Reads sync_queue directly; nothing is stored. A '
  'work_type that has never been enqueued is absent, not zero.';

-- -----------------------------------------------------------------------------
-- ghl_match_progress: per-business verdict on person, not on the queue.
--
-- What each bucket means:
--   matched      GHL returned exactly one contact for the identifier we tried
--   ambiguous    more than one contact matched - needs human resolution
--   unmatched    no contact found; the person exists on WL but not in GHL
--   failed       the search itself failed (API error, timeout, etc.)
--   never_tried  ghl_match_state is null - the matcher has not run yet
--
-- "never_tried" is a real category, not an alias for unmatched: an unmatched
-- verdict means we asked and the answer was "no", and a null means we never
-- asked. Merging them would hide whether the matcher had run at all.
-- -----------------------------------------------------------------------------
drop view if exists public.ghl_match_progress;

create view public.ghl_match_progress
  with (security_invoker = on) as
  select
    k_business,
    count(*)                                                          as people_total,
    count(*) filter (where ghl_match_state = 'matched')               as matched,
    count(*) filter (where ghl_match_state = 'ambiguous')             as ambiguous,
    count(*) filter (where ghl_match_state = 'unmatched')             as unmatched,
    count(*) filter (where ghl_match_state = 'failed')                as failed,
    count(*) filter (where ghl_match_state is null)                   as never_tried,
    -- The alert-window count: the criterion "an unresolved match has stayed
    -- unresolved for more than 48h" is a real signal - see 0023. Recording it
    -- here means the dashboard reads one row, not a second query.
    count(*) filter (
      where ghl_match_state in ('unmatched','ambiguous','failed')
        and ghl_unresolved_since < now() - interval '48 hours'
    ) as unresolved_over_48h,
    min(ghl_unresolved_since) filter (
      where ghl_match_state in ('unmatched','ambiguous','failed')
    ) as oldest_unresolved,
    case when count(*) = 0 then null
         else round(100.0 * count(*) filter (where ghl_match_state = 'matched') / count(*))
    end as pct_matched
  from public.person
  group by k_business;

comment on view public.ghl_match_progress is
  'Per-business GHL match picture: matched / ambiguous / unmatched / failed / '
  'never_tried, plus the 48h-alert count and the oldest unresolved timestamp. '
  'Reads person.ghl_match_state; never_tried is null and is distinct from '
  'unmatched on purpose (we did not ask vs we asked and got no).';
