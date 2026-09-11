-- =============================================================================
-- 0021  Which sessions may be counted for royalty, and which must not
--
-- Board item 7.5. Two kinds of session must never be counted as real attendance:
-- a booking REQUEST the studio has not confirmed (a proposal, not a booking), and
-- a session the studio has not REVIEWED (it may not have happened).
--
-- WHY A FLAG BESIDE THE OUTCOME, NOT A CHANGE TO IT
--   The obvious move is to make an unreviewed session stop saying 'attended'.
--   That destroys information: WellnessLiving genuinely reports a check-in, and
--   overwriting that with 'unreviewed' means nobody can later ask "what did WL
--   say before the studio looked at it".
--
--   So 0020's `outcome` keeps saying what HAPPENED, and this adds `is_countable`
--   saying whether it may be PAID ON. Royalty queries filter on is_countable;
--   anyone investigating reads outcome. The criterion "an unreviewed session is
--   never counted as attended" is met by the thing that does the counting, which
--   is where it belongs.
--
-- THE THREE COLUMNS
--   WL carries these on a_appointment_visit_info, on the same visit-detail
--   payload 0017 already reads - so no additional API call. Observed on 60 of 60
--   payloads sampled: is_request, is_confirmed and is_deny, all false throughout.
--
-- A WARNING ABOUT is_confirmed, WHICH IS WHY IT IS NOT USED AS A GATE
--   is_confirmed is FALSE on every one of the 60 payloads measured. If that were
--   read as "not confirmed", every session in the business would be excluded and
--   royalties would come to zero. is_request is also false on all 60, which says
--   there are no booking requests here at all - so is_confirmed is simply not
--   meaningful outside a request flow this studio does not use.
--
--   Therefore the exclusion is driven by is_request and is_denied, which mean
--   something on their own, and NOT by the absence of is_confirmed. A session is
--   excluded when it IS a pending request, or when it was denied - never merely
--   because nobody ticked a confirmation box. Getting this backwards is the
--   difference between "exclude the two proposals" and "exclude everything".
--
--   is_confirmed is still stored, because the day this studio turns the request
--   flow on it becomes the field that matters, and the value should already be
--   there rather than needing a backfill.
--
-- Safe to re-run.
-- =============================================================================

alter table public.session
  add column if not exists is_request   boolean not null default false,
  add column if not exists is_confirmed boolean not null default false,
  add column if not exists is_denied    boolean not null default false;

comment on column public.session.is_request is
  'This is a booking REQUEST the studio has not turned into a booking - a '
  'proposal. Excluded from countable work. False on 60 of 60 payloads measured: '
  'this studio does not appear to use the request flow.';
comment on column public.session.is_confirmed is
  'WL''s confirmation flag. FALSE on 60 of 60 measured, so it must NOT be used '
  'as an exclusion gate - doing so would exclude every session in the business. '
  'Stored for the day the request flow is switched on.';
comment on column public.session.is_denied is
  'The studio refused the request. Excluded from countable work.';

create index if not exists session_uncountable_idx
  on public.session (k_business)
  where is_request or is_denied or not is_reviewed;

-- -----------------------------------------------------------------------------
-- session_outcome, extended with is_countable
--
-- outcome  = what happened, per WL.
-- countable = whether it may earn a royalty.
-- They are different questions and are answered separately on purpose.
-- -----------------------------------------------------------------------------
drop view if exists public.session_outcome;

create view public.session_outcome
  with (security_invoker = on) as
  select
    a.k_period,
    a.dt_start_utc,
    a.uid,
    a.k_business,
    a.k_visit,
    s.session_kind,
    s.text_title,
    s.dtl_start_local,
    s.text_timezone,

    s.is_cancelled_studio,
    a.is_cancelled_client,
    a.is_attended,
    a.is_no_show,
    a.is_waitlisted,
    a.is_unpaid,
    s.is_checkin,
    s.dt_cancel_by,
    s.is_request,
    s.is_confirmed,
    s.is_denied,
    s.is_reviewed,

    case
      when s.is_cancelled_studio then 'studio_cancelled'
      when a.is_cancelled_client then 'client_cancelled'
      when s.is_denied           then 'denied'
      when s.is_request          then 'requested'
      when a.is_waitlisted       then 'waitlisted'
      when a.is_attended         then 'attended'
      when a.is_no_show          then 'missed'
      when s.dt_start_utc > now() then 'upcoming'
      else 'unknown'
    end as outcome,

    -- May this earn a royalty? A proposal is not work; work the studio has not
    -- reviewed may not have happened; and nothing that was cancelled, refused or
    -- merely queued is work at all.
    (
      s.is_reviewed
      and not s.is_request
      and not s.is_denied
      and not s.is_cancelled_studio
      and not a.is_cancelled_client
      and not a.is_waitlisted
      and s.dt_start_utc <= now()
    ) as is_countable

  from public.attendance a
  join public.session s
    on s.k_period = a.k_period
   and s.dt_start_utc = a.dt_start_utc;

comment on view public.session_outcome is
  'outcome says what happened; is_countable says whether it may be paid on. An '
  'unreviewed session can read attended and still be uncountable - which is the '
  'point: WL''s verdict is preserved AND royalty stays honest.';

-- -----------------------------------------------------------------------------
-- data_health_issue, with the two exclusions made visible
--
-- Criterion 4: a growing backlog must be noticeable. Recreated in full because
-- Postgres cannot append a branch to an existing view.
-- -----------------------------------------------------------------------------
create or replace view public.data_health_issue as
  select 'unmatched_contact'::text as issue,
         'person'::text            as table_name,
         p.uid                     as record_key,
         p.k_business,
         'no GoHighLevel contact linked'::text as detail,
         p.synced_at               as as_of
  from public.person p
  where p.ghl_match_state = 'unmatched'

  union all
  select 'ambiguous_contact', 'person', p.uid, p.k_business,
         'GoHighLevel match is ambiguous', p.synced_at
  from public.person p
  where p.ghl_match_state = 'ambiguous'

  union all
  select 'failed_contact_match', 'person', p.uid, p.k_business,
         'GoHighLevel match failed', p.synced_at
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
  -- NEW (7.5): proposals waiting on the studio. Counting these as work would
  -- pay a royalty on a lesson nobody agreed to teach.
  select 'unconfirmed_request', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'booking request the studio has not confirmed', s.synced_at
  from public.session s
  where s.is_request
    and not s.is_denied

  union all
  -- NEW (7.5): refused outright. Kept visible so a rising count is noticed
  -- rather than quietly filtered away.
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
  where r.process_error is not null;

comment on view public.data_health_issue is
  'Every known soft failure, one row each, in a uniform shape. Includes the two '
  '7.5 exclusions, so a backlog of unconfirmed or refused requests is visible '
  'rather than silently dropped from the counts.';
