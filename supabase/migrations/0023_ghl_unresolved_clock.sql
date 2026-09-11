-- =============================================================================
-- 0023  How long a client has been without a GoHighLevel link
--
-- Board item M05. Two of its criteria already held by accident and one could not
-- be built honestly at all; this migration turns the accidents into guarantees
-- and supplies the missing clock.
--
-- WHY A SECOND TIMESTAMP, WHEN 0022 JUST ADDED ONE
--   ghl_match_attempted_at answers "when did we last look". That is the wrong
--   clock for "unresolved beyond 48 hours", because a deliberate retry rewrites
--   it - so a record stuck as ambiguous for a month reads as two minutes old the
--   moment somebody re-runs the retry pass, and the alert can never fire. An
--   alert that cannot fire is worse than no alert: it reports safety.
--
--   ghl_unresolved_since answers "since when has this client had no usable
--   link". It is set once, survives every retry, and is cleared only by an
--   actual match.
--
-- WHY NOT synced_at, WHICH THE VIEW WAS ALREADY USING
--   The three GoHighLevel issues below reported p.synced_at as their as_of, and
--   data_health surfaces min(as_of) as `oldest`. synced_at moves on every WL
--   sync pass, so `oldest` on ambiguous_contact has been resetting several times
--   a day - it has never meant what its name says. Those three now report the
--   unresolved clock instead, which is the question anyone reading that column
--   is actually asking.
--
-- Safe to re-run.
-- =============================================================================

alter table public.person
  add column if not exists ghl_unresolved_since timestamptz;

comment on column public.person.ghl_unresolved_since is
  'Since when this client has had no usable GoHighLevel link. Set on the first '
  'non-matching outcome and NOT reset by later retries, so the 48-hour alert '
  'measures how long a human has left it unresolved rather than how recently a '
  'job ran. Null once matched.';

-- -----------------------------------------------------------------------------
-- A shared contact is legitimate, and must stay possible.
--
-- Several WellnessLiving clients mapping to one GoHighLevel contact is the
-- ordinary case of a family on one phone number: the phone search returns a
-- single contact, so every member of that family matches it. That is a correct
-- result, not a collision, and it is deliberately NOT flagged anywhere in
-- data_health_issue.
--
-- The only way this criterion can break is if somebody later adds a unique
-- index here on the reasonable-sounding grounds that a contact id ought to
-- identify one person. It ought not. supabase/checks/ghl_match_cases.sql asserts
-- no such index exists.
-- -----------------------------------------------------------------------------
comment on column public.person.ghl_contact_id is
  'The linked GoHighLevel contact. Deliberately NOT unique: a family sharing a '
  'phone number legitimately resolves several clients to one contact, and that '
  'is a correct match, not a conflict. Never add a unique index here.';

-- Reading "who has been unresolved too long" without scanning matched clients.
create index if not exists person_ghl_unresolved_since_idx
  on public.person (k_business, ghl_unresolved_since)
  where ghl_match_state <> 'matched';

-- -----------------------------------------------------------------------------
-- Backfill.
--
-- created_at is the honest floor: for a client who has never been matched, the
-- link has been empty since the row existed. It is not a guess at some earlier
-- moment - it is the earliest time we can actually defend.
--
-- Anything already matched gets null, because it is not unresolved.
-- -----------------------------------------------------------------------------
update public.person
   set ghl_unresolved_since = created_at
 where ghl_unresolved_since is null
   and ghl_match_state <> 'matched';

update public.person
   set ghl_unresolved_since = null
 where ghl_match_state = 'matched'
   and ghl_unresolved_since is not null;

-- =============================================================================
-- data_health_issue, recreated in full - Postgres cannot append a branch.
--
-- Changes from 0021:
--   * the three GoHighLevel issues report ghl_unresolved_since as as_of
--   * new branch: ghl_unresolved_48h
-- Everything else is carried over unchanged.
-- =============================================================================
create or replace view public.data_health_issue as
  -- Clients with no GoHighLevel link. NOT an error: the person is simply not in
  -- GoHighLevel, the client record stays complete, and nothing is created there
  -- to fill the gap. Listed so the size of the gap is visible.
  select 'unmatched_contact'::text as issue,
         'person'::text            as table_name,
         p.uid                     as record_key,
         p.k_business,
         'no GoHighLevel contact linked'::text as detail,
         p.ghl_unresolved_since    as as_of
  from public.person p
  where p.ghl_match_state = 'unmatched'

  union all
  -- More than one candidate. Never auto-resolved: choosing would put one
  -- person's royalties on another person's record.
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
  -- NEW (M05): the alert. Unresolved is normal; unresolved for two days means
  -- nobody has looked at it. Deliberately one branch covering all three
  -- unresolved states, because the thing being escalated is the AGE, not the
  -- reason - the reason already has its own row above.
  select 'ghl_unresolved_48h', 'person', p.uid, p.k_business,
         'GoHighLevel link unresolved (' || p.ghl_match_state || ') since '
           || p.ghl_unresolved_since::text,
         p.ghl_unresolved_since
  from public.person p
  where p.ghl_match_state <> 'matched'
    and p.ghl_unresolved_since is not null
    and p.ghl_unresolved_since < now() - interval '48 hours'

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
  where r.process_error is not null;

comment on view public.data_health_issue is
  'Every known soft failure, one row each, in a uniform shape. The GoHighLevel '
  'rows date from ghl_unresolved_since, not synced_at, so data_health.oldest '
  'measures how long a human has left something unresolved rather than how '
  'recently a sync ran. Several clients sharing one contact is NOT listed: it '
  'is a family on one phone number, and it is a correct match.';
