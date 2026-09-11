-- =============================================================================
-- 0033  sync_run.heartbeat_at - telling a live run from a corpse
--
-- THE PROBLEM, MEASURED.
--   closeRun() is the only thing that moves a run off 'running'. A process that
--   dies never reaches it, so the row stays 'running' forever. On 31 Aug 2026
--   there were FORTY such rows, the oldest from 21 Aug.
--
--   So `sync_run` could not answer the one question it exists to answer. "Is a
--   sync running right now?" came back yes, always, because forty ghosts said
--   so - and a live run was indistinguishable from a dead one.
--
--   That is not a cosmetic complaint. It is exactly how the 23505 got in: two
--   attendance_sync runs overlapped, one of them a corpse from 06:32 that
--   nothing had noticed, and the collision took the pass down with 32,440 items
--   left unqueued. A wrong answer to "is something already running" is what
--   allowed the race in the first place.
--
-- THE FIX, AND WHY IT IS THE SHAPE IT IS.
--   The queue already solved this problem for work ITEMS: a claim carries a
--   lease, and an item whose lease expired is reclaimed rather than stranded in
--   'in_progress' forever. Runs get the same treatment - a heartbeat the run
--   updates as it works, and a sweep that retires runs which stopped beating.
--   Copying a mechanism that is already proven here beats inventing a second
--   one that behaves almost the same.
--
-- WHY 'abandoned' IS ITS OWN STATE.
--   'failed' means the run caught something and said so. 'cancelled' means a
--   person stopped it. Neither describes a process that vanished without a
--   word, and the difference matters when reading the table later: a rising
--   count of 'abandoned' means something is killing processes - a crash, an
--   OOM, a closed terminal - which is a different problem with a different fix
--   from a pass that failed cleanly.
--
-- Safe to re-run.
-- =============================================================================

alter table public.sync_run
  add column if not exists heartbeat_at timestamptz;

comment on column public.sync_run.heartbeat_at is
  'When the run last said it was alive. Updated as it works, so a stale value '
  'means the process died without closing the run. The same idea as '
  'sync_queue.claim_expires_at, for runs rather than items.';

-- -----------------------------------------------------------------------------
-- 'abandoned' joins the allowed states.
--
-- Dropped and recreated because a check constraint cannot be widened in place.
-- -----------------------------------------------------------------------------
alter table public.sync_run
  drop constraint if exists sync_run_state_check;

alter table public.sync_run
  add constraint sync_run_state_check
  check (state in ('running', 'ok', 'partial', 'failed', 'cancelled', 'abandoned'));

-- The sweep reads exactly this: runs still claiming to be alive.
create index if not exists sync_run_running_idx
  on public.sync_run (heartbeat_at)
  where state = 'running';

-- -----------------------------------------------------------------------------
-- Retire the ghosts.
--
-- finished_at is required the moment state leaves 'running' (the
-- sync_run_finished_together constraint), and we do not know when these actually
-- stopped - only that they did. updated_at is the last moment the row was
-- touched, which is the closest defensible answer; inventing a precise time
-- would be worse than an approximate honest one.
-- -----------------------------------------------------------------------------
update public.sync_run
   set state       = 'abandoned',
       finished_at = coalesce(finished_at, updated_at, started_at),
       error       = coalesce(
         error,
         'no heartbeat: the process died without closing this run (retired by migration 0033)'
       )
 where state = 'running';

-- =============================================================================
-- data_health_issue: an abandoned run, and an alert that went missing
--
-- Recreated in full from the 0026 definition - Postgres cannot append a branch,
-- and a view must be written out complete, which is precisely how 0026 lost a
-- branch that 0023 had added. Checked against the LIVE view before rewriting:
-- stale_ghl_contact and missing_ghl_enrichment are 0026's and are kept.
-- =============================================================================
create or replace view public.data_health_issue as
  -- as_of is the UNRESOLVED CLOCK, not synced_at. data_health surfaces
  -- min(as_of) as `oldest`, and synced_at moves on every WL sync - so with
  -- synced_at these three reset several times a day and `oldest` never meant
  -- what its name says. 0023 fixed that; 0026 recreated this view from an older
  -- copy and quietly put synced_at back. Fixed again here.
  select 'unmatched_contact'::text as issue,
         'person'::text            as table_name,
         p.uid                     as record_key,
         p.k_business,
         'no GoHighLevel contact linked'::text as detail,
         p.ghl_unresolved_since    as as_of
  from public.person p
  where p.ghl_match_state = 'unmatched'

  union all
  select 'ambiguous_contact', 'person', p.uid, p.k_business,
         'GoHighLevel match is ambiguous - a human has to choose',
         p.ghl_unresolved_since
  from public.person p
  where p.ghl_match_state = 'ambiguous'

  union all
  select 'failed_contact_match', 'person', p.uid, p.k_business,
         'GoHighLevel match failed', p.ghl_unresolved_since
  from public.person p
  where p.ghl_match_state = 'failed'

  union all
  select 'unreviewed_session', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'session has passed and is not reviewed', s.synced_at
  from public.session s
  where not s.is_reviewed
    and s.dt_start_utc < now()
    and not s.is_cancelled_studio

  union all
  select 'unconfirmed_request', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'booking request the studio has not confirmed', s.synced_at
  from public.session s
  where s.is_request
    and not s.is_denied

  union all
  select 'denied_request', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'booking request the studio refused', s.synced_at
  from public.session s
  where s.is_denied

  union all
  select 'stale_person', 'person', p.uid, p.k_business,
         'not confirmed against WL since ' || p.synced_at::text, p.synced_at
  from public.person p
  where p.synced_at < now() - public.stale_after()

  union all
  select 'stale_purchase', 'purchase', pu.k_purchase, pu.k_business,
         'not confirmed against WL since ' || pu.synced_at::text, pu.synced_at
  from public.purchase pu
  where pu.synced_at < now() - public.stale_after()

  union all
  select 'stale_session', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'not confirmed against WL since ' || s.synced_at::text, s.synced_at
  from public.session s
  where s.synced_at < now() - public.stale_after()

  union all
  select 'open_conflict', c.table_name, c.record_key, c.k_business,
         c.reason, c.created_at
  from public.sync_conflict c
  where c.resolution_state = 'open'

  union all
  select 'unprocessed_raw_wl', 'raw_wl', r.id::text, r.k_business,
         'fetched from ' || r.source_endpoint || ' and not parsed', r.fetched_at
  from public.raw_wl r
  where r.processed_at is null

  union all
  select 'failed_raw_wl', 'raw_wl', r.id::text, r.k_business,
         coalesce(r.process_error, 'parse failed'), r.fetched_at
  from public.raw_wl r
  where r.process_error is not null

  union all
  -- NEW (M06): the GoHighLevel snapshot has aged past ghl_stale_after().
  --
  -- READ THIS AS AN AGE, NOT A FAULT. Nothing refreshes enrichment, so this row
  -- appears 30 days after a client is matched and does not go away. It is here
  -- so that somebody reading a royalty report can see the GoHighLevel half of a
  -- client record is months old - not so that anybody chases it.
  --
  -- Dated from fetched_at, not synced_at - synced_at moves on every WL sync, so
  -- data_health.oldest would report the wrong age, which is the bug 0023 had to
  -- fix for the unresolved rows.
  select 'stale_ghl_contact', 'person', p.uid, p.k_business,
         'GoHighLevel fields last fetched ' || gc.fetched_at::text, gc.fetched_at
  from public.person p
  join public.ghl_contact gc on gc.ghl_contact_id = p.ghl_contact_id
  where gc.fetched_at < now() - public.ghl_stale_after()

  union all
  -- NEW (M06): linked, but nothing was ever stored. A DIFFERENT issue from both
  -- stale and unmatched. unmatched means GoHighLevel has nobody; stale means we
  -- read them a while ago; this means it has somebody and we hold nothing.
  --
  -- Unlike stale, this one is actionable and it clears - and closing it costs no
  -- API call, because the payload is already in raw_ghl.
  select 'missing_ghl_enrichment', 'person', m.uid, m.k_business,
         'linked to a GoHighLevel contact with no stored fields or tags',
         m.ghl_match_attempted_at
  from public.ghl_enrichment_missing m

  union all
  -- RESTORED. Added by 0023 for board item M05, then lost when 0026 recreated
  -- this view from an older copy - a view has to be written out in full, so a
  -- branch nobody retypes simply disappears. Nothing failed and nothing said
  -- anything; the 48-hour alert just stopped existing.
  --
  -- Unresolved is normal; unresolved for two days means nobody has looked. One
  -- branch covers all three unresolved states because what is escalated is the
  -- AGE, not the reason - the reason already has its own row above.
  select 'ghl_unresolved_48h', 'person', p.uid, p.k_business,
         'GoHighLevel link unresolved (' || p.ghl_match_state || ') since '
           || p.ghl_unresolved_since::text,
         p.ghl_unresolved_since
  from public.person p
  where p.ghl_match_state <> 'matched'
    and p.ghl_unresolved_since is not null
    and p.ghl_unresolved_since < now() - interval '48 hours'

  union all
  -- NEW (0033): a run whose process died without ever closing it. A rising
  -- count means something is killing processes - a crash, an OOM, a closed
  -- terminal - which is a different problem, with a different fix, from a pass
  -- that failed and said so.
  select 'abandoned_run', 'sync_run', r.run_id, r.k_business,
         'run ' || r.job_name || ' stopped without closing (last heartbeat '
           || coalesce(r.heartbeat_at::text, 'never') || ')',
         coalesce(r.heartbeat_at, r.started_at)
  from public.sync_run r
  where r.state = 'abandoned';

comment on view public.data_health_issue is
  'Every known soft failure, one row each, in a uniform shape. abandoned_run '
  'surfaces processes that died without closing their run - the condition that '
  'let two passes overlap and collide on 31 Aug 2026. ghl_unresolved_48h was '
  'added by 0023, silently lost when 0026 recreated this view, and restored '
  'here.';
