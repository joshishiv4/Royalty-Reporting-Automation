-- =============================================================================
-- 0010  data health views, supporting views, and RLS policies
--
-- Four things, in dependency order:
--   1. columns the views need and the schema did not have
--   2. the health view and its drill-down
--   3. customer journey and enrollment margin
--   4. RLS policies, without which "RLS is enabled" means nobody can read
--      anything - including their own row
--
-- TWO DECISIONS I MADE RATHER THAN GUESS SILENTLY
--
-- "Stale" is 24 hours, in one place - public.stale_after(). The sync is a daily
-- job, so a row not confirmed against WL for a day has missed a cycle. Change the
-- function, not eleven views.
--
-- "Unreviewed session" needed a column. The schema had no notion of studio
-- review, so is_reviewed / reviewed_at / reviewed_by are added to session. Without
-- them the criterion is unsatisfiable, not merely unmet.
--
-- ONE THING I COULD NOT BUILD, AND WHY
--
-- Enrollment margin needs teacher cost, and WL does not expose it. Measured:
-- /v1/staff/list returns a_pay_rate as an array of KEYS - ["310036","308721"] -
-- and a_staff_service as {"k_service":"142047","k_staff_pay":"310041"}. Keys,
-- never amounts. No endpoint in WL's own Postman collection (75 of them) resolves
-- a k_staff_pay to a rate; the three that match /pay|rate/ are customer payment
-- endpoints.
--
-- So staff_pay_rate stores the keys WL does give us with a nullable m_rate beside
-- them, and enrollment_margin reports revenue truthfully with cost null. The view
-- exists, is correct, and says so - which is better than inventing a rate and
-- publishing a margin that looks authoritative and is fiction.
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- 1a. The staleness threshold, in ONE place
-- -----------------------------------------------------------------------------
create or replace function public.stale_after()
returns interval
language sql
immutable
as $$ select interval '24 hours' $$;

comment on function public.stale_after() is
  'How long since synced_at before a row counts as stale. The sync runs daily, '
  'so a day without confirmation means a missed cycle. One place to change it.';

-- -----------------------------------------------------------------------------
-- 1b. Studio review on a session
-- -----------------------------------------------------------------------------
alter table public.session
  add column if not exists is_reviewed boolean not null default false,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text;

comment on column public.session.is_reviewed is
  'Studio has checked this occurrence. Nothing in WL supplies it - it is our own '
  'workflow state, set by whoever reviews.';

-- A reviewed session must say when.
alter table public.session drop constraint if exists session_reviewed_together;
alter table public.session add constraint session_reviewed_together
  check ((is_reviewed = false) or (reviewed_at is not null));

-- The health query: unreviewed sessions that have already happened.
create index if not exists session_unreviewed_idx
  on public.session (k_business, dt_start_utc)
  where not is_reviewed;

-- -----------------------------------------------------------------------------
-- 1c. Staff pay - the keys WL gives us, and room for the rate it does not
-- -----------------------------------------------------------------------------
create table if not exists public.staff_pay_rate (
  k_staff_pay      text        primary key,
  k_business       text        not null,
  k_staff          text,

  -- NULL until someone supplies it. WL sends only the key, so this is filled by
  -- hand, by an export, or by an endpoint WL has not published.
  m_rate           numeric(12, 2),
  text_currency    text,
  -- 'per_session' | 'per_head' | 'hourly' | 'percent' - unknown until a rate
  -- arrives with its meaning, so text rather than an enum.
  rate_basis       text,
  -- Where the number came from, since it did not come from the API.
  rate_source      text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz not null default now()
);

comment on table public.staff_pay_rate is
  'WL returns pay rate KEYS only (a_pay_rate is ["310036",...]) and no endpoint '
  'resolves them to amounts. m_rate is null until supplied another way.';

create index if not exists staff_pay_rate_staff_idx on public.staff_pay_rate (k_staff);

-- Which service a staff member teaches, and under which pay key.
-- Observed shape: {"k_service":"142047","k_staff_pay":"310041"}.
create table if not exists public.staff_service (
  k_staff          text        not null,
  k_service        text        not null,
  k_business       text        not null,
  k_staff_pay      text        references public.staff_pay_rate (k_staff_pay) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz not null default now(),

  constraint staff_service_pkey primary key (k_staff, k_service)
);

-- -----------------------------------------------------------------------------
-- 1d. The portal identity link
-- -----------------------------------------------------------------------------
-- RLS needs to answer "is this row yours", and WL's uid (8 digits) is not a
-- Supabase auth user id (a uuid). One column joins the two, and it is the only
-- thing the policies below depend on.
alter table public.person
  add column if not exists auth_user_id uuid;

comment on column public.person.auth_user_id is
  'Supabase auth.users id for the portal. NULL until the person signs up. Every '
  'RLS policy in this migration keys off it.';

create unique index if not exists person_auth_user_id_key
  on public.person (auth_user_id)
  where auth_user_id is not null;

-- =============================================================================
-- 2. Data health
-- =============================================================================

-- One row per issue, uniform shape, so a person or a dashboard can read the
-- whole list without knowing which table each problem came from.
create or replace view public.data_health_issue as
  -- Clients with no GoHighLevel link.
  select 'unmatched_contact'::text as issue,
         'person'::text            as table_name,
         p.uid                     as record_key,
         p.k_business,
         'no GoHighLevel contact linked'::text as detail,
         p.synced_at               as as_of
  from public.person p
  where p.ghl_match_state = 'unmatched'

  union all
  -- Matches that hit more than one candidate: a human has to choose.
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
  -- Sessions that have already run and nobody has checked.
  select 'unreviewed_session', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'session has passed and is not reviewed', s.synced_at
  from public.session s
  where not s.is_reviewed
    and s.dt_start_utc < now()
    and not s.is_cancelled_studio

  union all
  -- Stale: not confirmed against WL for longer than stale_after().
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
  -- Conflicts already parked for a human.
  select 'open_conflict', c.table_name, c.record_key, c.k_business,
         c.reason, c.created_at
  from public.sync_conflict c
  where c.resolution_state = 'open'

  union all
  -- Raw payloads fetched but never parsed.
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
  'Every known soft failure, one row each, in a uniform shape. Drill-down behind '
  'the data_health summary.';

-- The answer to "is the data trustworthy right now", in one screen.
create or replace view public.data_health as
  select issue,
         k_business,
         count(*)      as issue_count,
         min(as_of)    as oldest,
         max(as_of)    as newest
  from public.data_health_issue
  group by issue, k_business
  order by count(*) desc, issue;

comment on view public.data_health is
  'Counts per issue. Empty means nothing known is wrong - which is not the same '
  'as everything being right, only that every check we have passes.';

-- =============================================================================
-- 3. Supporting views
-- =============================================================================

-- Customer journey: one row per person, the shape of their relationship.
create or replace view public.customer_journey as
  select
    p.uid,
    p.k_business,
    p.first_name,
    p.last_name,
    p.text_login_type                      as client_type,
    (p.k_staff is not null)                as is_staff,
    p.created_at                           as known_since,

    -- Money
    count(distinct pu.k_purchase)          as purchase_count,
    coalesce(sum(pi.m_price_total), 0)     as lifetime_value,
    min(pu.dt_add)                         as first_purchase_at,
    max(pu.dt_add)                         as last_purchase_at,

    -- Attendance
    count(distinct a.k_period || '|' || a.dt_start_utc::text)
      filter (where a.is_attended)         as sessions_attended,
    count(distinct a.k_period || '|' || a.dt_start_utc::text)
      filter (where a.is_no_show)          as no_shows,
    count(distinct a.k_period || '|' || a.dt_start_utc::text)
      filter (where a.is_cancelled_client) as client_cancellations,
    max(a.dt_start_utc)
      filter (where a.is_attended)         as last_attended_at,

    -- Where they are now. Ordering matters: the first matching branch wins, so
    -- "never bought" is checked before any recency rule.
    case
      when count(pu.k_purchase) = 0                              then 'prospect'
      when max(a.dt_start_utc) filter (where a.is_attended)
             > now() - interval '30 days'                         then 'active'
      when max(a.dt_start_utc) filter (where a.is_attended)
             > now() - interval '90 days'                         then 'lapsing'
      when max(a.dt_start_utc) filter (where a.is_attended) is not null
                                                                 then 'dormant'
      else 'purchased_never_attended'
    end                                    as journey_stage,

    p.ghl_match_state,
    p.ghl_contact_id
  from public.person p
  left join public.purchase pu
         on pu.uid_recipient = p.uid or pu.uid_payer = p.uid
  left join public.purchase_item pi on pi.k_purchase = pu.k_purchase
  left join public.attendance a on a.uid = p.uid
  group by p.uid, p.k_business, p.first_name, p.last_name, p.text_login_type,
           p.k_staff, p.created_at, p.ghl_match_state, p.ghl_contact_id;

comment on view public.customer_journey is
  'One row per person: money, attendance, and where they currently stand. '
  'journey_stage checks "never bought" before any recency rule.';

-- Enrollment margin. Revenue is real; cost is null until pay rates exist.
create or replace view public.enrollment_margin as
  select
    s.k_period,
    s.dt_start_utc,
    s.k_business,
    s.k_location,
    s.session_kind,
    s.text_title,
    s.i_capacity,

    count(distinct a.uid) filter (where a.is_attended)          as attended,
    count(distinct a.uid) filter (where a.is_no_show)           as no_shows,
    count(distinct a.uid)                                       as booked,
    -- Null capacity would make this a divide-by-zero, so it stays null.
    round(
      count(distinct a.uid) filter (where a.is_attended)::numeric
      / nullif(s.i_capacity, 0) * 100, 1
    )                                                           as fill_rate_pct,

    -- Revenue attributable to this session, from the items actually linked to it.
    coalesce(sum(distinct_items.m_price_total), 0)              as revenue,

    -- COST IS NOT AVAILABLE. WL returns pay rate keys, never amounts, and no
    -- endpoint resolves them - see the header. Populate staff_pay_rate.m_rate and
    -- this begins reporting; until then it is null rather than zero, because zero
    -- would read as "this session cost nothing".
    sum(spr.m_rate)                                             as teacher_cost,
    coalesce(sum(distinct_items.m_price_total), 0) - sum(spr.m_rate) as margin,
    bool_and(spr.m_rate is not null)                            as cost_is_known,

    string_agg(distinct ss.k_staff, ', ')                       as taught_by,
    bool_or(ss.is_substitute)                                   as had_substitute
  from public.session s
  left join public.attendance a
         on a.k_period = s.k_period and a.dt_start_utc = s.dt_start_utc
  left join public.session_staff ss
         on ss.k_period = s.k_period and ss.dt_start_utc = s.dt_start_utc
  left join public.staff_service sv on sv.k_staff = ss.k_staff
  left join public.staff_pay_rate spr on spr.k_staff_pay = sv.k_staff_pay
  left join lateral (
    -- Items tied to this occurrence through the appointment key. Classes are not
    -- linked to a purchase item in WL's model, so this is null for them - stated
    -- rather than papered over with a guess.
    select sum(pi.m_price_total) as m_price_total
    from public.purchase_item pi
    where pi.k_appointment = s.k_appointment and s.k_appointment is not null
  ) as distinct_items on true
  where not s.is_cancelled_studio
  group by s.k_period, s.dt_start_utc, s.k_business, s.k_location,
           s.session_kind, s.text_title, s.i_capacity;

comment on view public.enrollment_margin is
  'Fill rate and revenue per session. teacher_cost and margin are NULL until '
  'staff_pay_rate.m_rate is populated - WL exposes pay keys, not amounts. '
  'cost_is_known says whether the margin on a row means anything.';

-- =============================================================================
-- 4. Row Level Security policies
-- =============================================================================
-- RLS was already ENABLED everywhere, but with no policies. That is not a working
-- state: with RLS on and nothing granted, `authenticated` sees zero rows -
-- including its own - so the portal would render empty. Enabled without policies
-- is a locked door with no key rather than a door with a lock.
--
-- service_role is unaffected throughout: it carries BYPASSRLS, which is how the
-- sync workers write at all.
--
-- Every policy below is SELECT only. The portal reads; nothing about it writes.

-- person: your own row, and only via auth_user_id.
drop policy if exists person_self_select on public.person;
create policy person_self_select on public.person
  for select to authenticated
  using (auth_user_id = auth.uid());

-- purchase: yours as payer OR as recipient. A parent who paid for a child should
-- see the purchase; so should the child it was for.
drop policy if exists purchase_self_select on public.purchase;
create policy purchase_self_select on public.purchase
  for select to authenticated
  using (
    exists (
      select 1 from public.person p
      where p.auth_user_id = auth.uid()
        and (p.uid = purchase.uid_payer or p.uid = purchase.uid_recipient)
    )
  );

drop policy if exists purchase_item_self_select on public.purchase_item;
create policy purchase_item_self_select on public.purchase_item
  for select to authenticated
  using (
    exists (
      select 1 from public.purchase pu
      join public.person p on p.auth_user_id = auth.uid()
      where pu.k_purchase = purchase_item.k_purchase
        and (p.uid = pu.uid_payer or p.uid = pu.uid_recipient)
    )
  );

-- attendance: your own bookings.
drop policy if exists attendance_self_select on public.attendance;
create policy attendance_self_select on public.attendance
  for select to authenticated
  using (
    exists (
      select 1 from public.person p
      where p.auth_user_id = auth.uid() and p.uid = attendance.uid
    )
  );

-- session: readable when you attended it. Class times are not secret, but this
-- keeps the portal to what a student has a reason to see rather than the studio's
-- whole timetable.
drop policy if exists session_attended_select on public.session;
create policy session_attended_select on public.session
  for select to authenticated
  using (
    exists (
      select 1
      from public.attendance a
      join public.person p on p.auth_user_id = auth.uid()
      where a.k_period = session.k_period
        and a.dt_start_utc = session.dt_start_utc
        and a.uid = p.uid
    )
  );

-- No policies on lead, raw_wl, raw_ghl, raw_link, sync_* or staff_pay_rate. That
-- is deliberate: those are operational tables and a student has no business in
-- any of them. Absence of a policy means absence of access.

-- =============================================================================
-- Triggers on the new tables
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array['staff_pay_rate', 'staff_service']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.set_updated_at()',
                   t || '_set_updated_at', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;

-- Views read person, so they must defer to the caller or they hand out
-- everything regardless of the policies above.
alter view public.data_health        set (security_invoker = on);
alter view public.data_health_issue  set (security_invoker = on);
alter view public.customer_journey   set (security_invoker = on);
alter view public.enrollment_margin  set (security_invoker = on);

-- =============================================================================
-- Verification
-- =============================================================================
select viewname,
       coalesce(
         (select option_value from pg_options_to_table(c.reloptions)
          where option_name = 'security_invoker'),
         'OFF - BYPASSES RLS'
       ) as security_invoker
from pg_views v
join pg_class c on c.relname = v.viewname
join pg_namespace n on n.oid = c.relnamespace and n.nspname = v.schemaname
where v.schemaname = 'public'
order by viewname;

select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
