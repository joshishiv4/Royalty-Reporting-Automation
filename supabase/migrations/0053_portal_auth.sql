-- =============================================================================
-- 0053  Portal auth - one auth anchor, and the policies that make signing in
--       mean something
--
-- WHY THIS EXISTS
--   Nobody has ever authenticated against this database. `0010` wrote five
--   SELECT policies keyed on `person.auth_user_id`; `0039` added a second anchor
--   on `identity`; `0048` wrote no policy at all and said why:
--
--     "A policy written now would be written against a shape no request has ever
--      taken."
--
--   A request is about to take that shape. This migration is the one DATA-MODEL.md
--   names as "the migration that also wires portal login", and it does the four
--   things that section asks for.
--
-- MEASURED BEFORE WRITING, 8 Oct 2026, read-only against live
--   identity.auth_user_id ... populated on 0 of 1,297 rows
--   person.auth_user_id .... populated on 0 rows
--   identities with no uid . 0
--   So the cost of moving the anchor is still zero, which is exactly why it is
--   being moved now rather than later. A guard below REFUSES to drop the column
--   if that has stopped being true - a measurement taken today is not a promise
--   about the day this is applied.
--
-- WHAT THIS DOES NOT DO
--   No write policy. `0010` said it plainly - "Every policy below is SELECT only.
--   The portal reads; nothing about it writes" - and that is still true here. The
--   uploads route writes `creation` through the service role, and it will keep
--   doing so until a task deliberately opens the write posture.
--
-- THE TRAP THIS MIGRATION EXISTS TO AVOID, STATED ONCE
--   A policy's subquery runs AS THE CALLER. So a policy on `app.student` that
--   reads `app.identity` to find out who the caller is, is itself filtered by
--   the policy on `app.identity` - and the lookup that was supposed to establish
--   identity returns nothing. The four helpers in section 2 are SECURITY DEFINER
--   for that reason. They are not an optimisation; without them the policies
--   below return zero rows for everybody and look like a data problem.
--
-- Safe to re-run.
-- =============================================================================

-- =============================================================================
-- 1. One auth anchor, not two
-- =============================================================================
-- `person.auth_user_id` (0010) and `identity.auth_user_id` (0039) both exist and
-- both are empty. `identity` is the correct one and it is not a close call: it is
-- the only anchor a portal-native human can ever have, because `person.uid` is
-- WellnessLiving's and NOT NULL, so a student WL has never heard of cannot have a
-- `person` row to hang a login on.
--
-- Two anchors is not merely redundant. It is a future bug where half the policies
-- key off one, half off the other, and a human linked through the wrong one reads
-- nothing while appearing signed in.

do $$
declare
  n_linked int;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'person'
      and column_name = 'auth_user_id'
  ) then
    execute 'select count(*) from public.person where auth_user_id is not null'
      into n_linked;

    -- A measurement taken while writing this file is not a statement about the
    -- database it is applied to. If somebody has signed in through the old
    -- anchor in the meantime, dropping the column destroys the only record of
    -- which human they are. Refuse, loudly, rather than discover it later.
    if n_linked > 0 then
      raise exception
        '0053 refuses to drop person.auth_user_id: % row(s) carry one. Migrate '
        'them onto identity.auth_user_id first - the mapping is person.uid -> '
        'identity.uid - then re-run.', n_linked;
    end if;
  end if;
end
$$;

-- THE OLD POLICIES MUST GO FIRST, AND THIS ORDER IS NOT COSMETIC.
--
-- All five of `0010`'s policies read `person.auth_user_id` - one directly, four
-- through a subquery on `person` - so Postgres records a dependency and refuses
-- to drop the column out from under them:
--
--   ERROR: cannot drop column auth_user_id of table person because other
--          objects depend on it
--
-- `DROP COLUMN ... CASCADE` would silently take the policies with it and leave
-- the mirror with RLS on and nothing granted - every table readable by nobody,
-- discovered later as "the portal shows nothing". Dropping them by name here is
-- the same outcome made deliberate, and section 3 puts all five back.
drop policy if exists person_self_select        on public.person;
drop policy if exists purchase_self_select      on public.purchase;
drop policy if exists purchase_item_self_select on public.purchase_item;
drop policy if exists attendance_self_select    on public.attendance;
drop policy if exists session_attended_select   on public.session;

-- The index goes with the column.
alter table public.person drop column if exists auth_user_id;

-- =============================================================================
-- 2. Who is asking
-- =============================================================================
-- Four helpers, all SECURITY DEFINER and STABLE. See "THE TRAP" in the header for
-- why definer, and not as a performance note.
--
-- `set search_path = ''` on every one of them. A SECURITY DEFINER function runs
-- with the owner's privileges, so an unpinned search_path lets any caller who can
-- create a schema shadow a table name and have it read with those privileges.
-- The cost is that every name below must be schema-qualified, including
-- `auth.uid()`.
--
-- They reveal only the caller's own ids, so EXECUTE is granted to `authenticated`
-- rather than left with PUBLIC - a signed-out caller has no auth.uid() and would
-- get null anyway, but a function that can be called by anybody invites being
-- called by anybody.

-- The signed-in human, as this database knows them.
create or replace function app.current_identity_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.id
  from app.identity i
  where i.auth_user_id = auth.uid()
  limit 1
$$;

comment on function app.current_identity_id() is
  'The identity of the signed-in auth user, or NULL. SECURITY DEFINER because a '
  'policy that looked this up inline would be filtered by the policy on identity.';

-- Their student role, which is what the portal actually addresses.
-- NULL for a teacher, and NULL for a human who has not been linked yet. Both of
-- those must read as "no rows", never as "all rows".
create or replace function app.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.student_id
  from app.identity i
  where i.auth_user_id = auth.uid()
  limit 1
$$;

comment on function app.current_student_id() is
  'The signed-in human''s student role id, or NULL. NULL must mean no rows: every '
  'policy using it compares with = so a NULL yields NULL, never true.';

-- Their WellnessLiving client id, for the policies on the mirror.
-- NULL for a portal-native human, which is the true answer - WL cannot know them,
-- so an empty schedule is correct rather than a failure.
create or replace function app.current_wl_uid()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select i.uid
  from app.identity i
  where i.auth_user_id = auth.uid()
  limit 1
$$;

comment on function app.current_wl_uid() is
  'The signed-in human''s WellnessLiving uid, or NULL for a portal-native human. '
  'Used only by the policies on the public mirror.';

-- The organizations they belong to.
--
-- DATA-MODEL.md asks for this one by name: "A security definer helper over
-- organization_membership, so a policy does not join it inline on every row."
-- Ended and invited memberships are excluded - a membership is kept after it ends
-- because it explains attendance and payments that are still there, but it is not
-- a key to today's data.
create or replace function app.current_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from app.organization_membership m
  where m.identity_id = app.current_identity_id()
    and m.status = 'active'
$$;

comment on function app.current_org_ids() is
  'Organizations the signed-in human is an ACTIVE member of. Ended and invited '
  'memberships are excluded: kept for history, not a key to current data.';

revoke execute on function app.current_identity_id() from public;
revoke execute on function app.current_student_id()  from public;
revoke execute on function app.current_wl_uid()      from public;
revoke execute on function app.current_org_ids()     from public;

grant execute on function app.current_identity_id() to authenticated, service_role;
grant execute on function app.current_student_id()  to authenticated, service_role;
grant execute on function app.current_wl_uid()      to authenticated, service_role;
grant execute on function app.current_org_ids()     to authenticated, service_role;

-- =============================================================================
-- 3. The WellnessLiving mirror - 0010's five policies, re-pointed
-- =============================================================================
-- Same five tables, same SELECT-only posture, same intent. The only change is
-- which column answers "is this row yours", and it is now reached through the hub
-- instead of through a column on `person` that no longer exists.
--
-- A portal-native human gets NULL from app.current_wl_uid(), and `uid = NULL` is
-- NULL rather than true, so every one of these returns nothing for them. That is
-- the correct answer and it is one of this task's acceptance criteria: WL cannot
-- know them, so an empty schedule is the true statement, not a fabricated one.

-- person: your own row.
drop policy if exists person_self_select on public.person;
create policy person_self_select on public.person
  for select to authenticated
  using (person.uid = app.current_wl_uid());

-- purchase: yours as payer OR as recipient. Unchanged in meaning from 0010 - a
-- parent who paid for a child should see the purchase; so should the child.
drop policy if exists purchase_self_select on public.purchase;
create policy purchase_self_select on public.purchase
  for select to authenticated
  using (
    app.current_wl_uid() is not null
    and (
      purchase.uid_payer = app.current_wl_uid()
      or purchase.uid_recipient = app.current_wl_uid()
    )
  );

drop policy if exists purchase_item_self_select on public.purchase_item;
create policy purchase_item_self_select on public.purchase_item
  for select to authenticated
  using (
    app.current_wl_uid() is not null
    and exists (
      select 1 from public.purchase pu
      where pu.k_purchase = purchase_item.k_purchase
        and (
          pu.uid_payer = app.current_wl_uid()
          or pu.uid_recipient = app.current_wl_uid()
        )
    )
  );

-- attendance: your own bookings.
drop policy if exists attendance_self_select on public.attendance;
create policy attendance_self_select on public.attendance
  for select to authenticated
  using (attendance.uid = app.current_wl_uid());

-- session: readable when you attended it. Class times are not secret, but this
-- keeps the portal to what a student has a reason to see rather than the studio's
-- whole timetable. 0010's reasoning, kept.
drop policy if exists session_attended_select on public.session;
create policy session_attended_select on public.session
  for select to authenticated
  using (
    app.current_wl_uid() is not null
    and exists (
      select 1 from public.attendance a
      where a.k_period = session.k_period
        and a.dt_start_utc = session.dt_start_utc
        and a.uid = app.current_wl_uid()
    )
  );

-- =============================================================================
-- 4. The portal's own tables
-- =============================================================================
-- These eleven tables have had RLS enabled with no policies since 0047/0048,
-- which means service_role only. Signing in without this section would make the
-- dashboard EMPTIER than it is today: the route would stop using the service key
-- and start reading as the student, and the student can see nothing.
--
-- Everything below hangs off app.current_student_id(). One function, one notion
-- of "me", so there is no second definition to drift.

-- student: your own row, and nobody else's.
drop policy if exists student_self_select on app.student;
create policy student_self_select on app.student
  for select to authenticated
  using (student.id = app.current_student_id());

-- identity: your own hub row.
--
-- Safe to expose and worth exposing: it is how a signed-in caller discovers
-- which student they are without an extra round trip through a function. It does
-- carry `uid` and `k_staff`, which are WellnessLiving's - the portal is specified
-- never to LEARN that WL exists, and reading your own mapping row does not
-- contradict that. If that ever feels wrong, the answer is a view with the WL
-- columns dropped, not a policy that lies about which row is yours.
--
-- No subquery here on purpose. This is the one policy that must not call the
-- helpers, because the helpers read this table.
drop policy if exists identity_self_select on app.identity;
create policy identity_self_select on app.identity
  for select to authenticated
  using (identity.auth_user_id = auth.uid());

-- attendance_record: your own bookings.
drop policy if exists attendance_record_self_select on app.attendance_record;
create policy attendance_record_self_select on app.attendance_record
  for select to authenticated
  using (attendance_record.student_id = app.current_student_id());

-- class_session: the sessions you are on.
--
-- The subquery reads app.attendance_record, which has its own policy, which is
-- itself filtered to this student. That nesting is fine and deliberate - it means
-- this policy cannot be wider than the one above it even by mistake. There is no
-- cycle: attendance_record's policy names no table at all.
drop policy if exists class_session_attended_select on app.class_session;
create policy class_session_attended_select on app.class_session
  for select to authenticated
  using (
    exists (
      select 1 from app.attendance_record ar
      where ar.class_session_id = class_session.id
        and ar.student_id = app.current_student_id()
    )
  );

-- cohort: the class groups you have actually sat in.
drop policy if exists cohort_attended_select on app.cohort;
create policy cohort_attended_select on app.cohort
  for select to authenticated
  using (
    exists (
      select 1
      from app.class_session cs
      join app.attendance_record ar on ar.class_session_id = cs.id
      where cs.cohort_id = cohort.id
        and ar.student_id = app.current_student_id()
    )
  );

-- class_session_teacher: who taught the sessions you were on.
drop policy if exists class_session_teacher_attended_select on app.class_session_teacher;
create policy class_session_teacher_attended_select on app.class_session_teacher
  for select to authenticated
  using (
    exists (
      select 1 from app.attendance_record ar
      where ar.class_session_id = class_session_teacher.class_session_id
        and ar.student_id = app.current_student_id()
    )
  );

-- teacher: the teachers who taught you, and no others.
--
-- NOT "every teacher". The dashboard needs a name beside a session, which is a
-- reason to see one row; it is not a reason to hand a student the staff list.
drop policy if exists teacher_taught_select on app.teacher;
create policy teacher_taught_select on app.teacher
  for select to authenticated
  using (
    exists (
      select 1
      from app.class_session_teacher cst
      join app.attendance_record ar on ar.class_session_id = cst.class_session_id
      where cst.teacher_id = teacher.id
        and ar.student_id = app.current_student_id()
    )
  );

-- creation: your own uploads.
--
-- SELECT only, like everything else here. The uploads route still writes through
-- the service role; opening the write posture is a separate decision and is not
-- taken by accident in a migration about reading.
drop policy if exists creation_self_select on app.creation;
create policy creation_self_select on app.creation
  for select to authenticated
  using (creation.student_id = app.current_student_id());

-- organization: the ones you belong to. The only policy that uses the membership
-- helper, which is what keeps that helper honest rather than decorative.
drop policy if exists organization_member_select on app.organization;
create policy organization_member_select on app.organization
  for select to authenticated
  using (organization.id in (select app.current_org_ids()));

-- organization_membership: your own memberships.
drop policy if exists organization_membership_self_select on app.organization_membership;
create policy organization_membership_self_select on app.organization_membership
  for select to authenticated
  using (organization_membership.identity_id = app.current_identity_id());

-- -----------------------------------------------------------------------------
-- NO POLICY ON cohort_link, session_link OR attendance_link. Deliberate.
--
-- Those three exist to carry WellnessLiving keys - k_class, k_period,
-- dt_start_utc, uid, k_business - and nothing else. They are the translation
-- layer, and the standing rule is that the portal reads the hub and never learns
-- WellnessLiving exists. RLS stays enabled with no policy, which means
-- service_role only. Absence of a policy is absence of access, and that is the
-- intended answer rather than an omission.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- 5. Grants - without which every policy above is theatre
-- =============================================================================
-- `0047` granted USAGE on the schema to anon and authenticated, and then granted
-- TABLE privileges to service_role ONLY. In `public` that gap does not arise,
-- because Supabase's own bootstrap sets default privileges there; `app` was
-- created by us, so nothing granted anything.
--
-- The failure mode is worth naming, because it does not look like a permissions
-- problem from the client: with a policy but no grant, the answer is
-- `permission denied for table student` - a 42501, not an empty result. A
-- reviewer reading the policies alone would conclude the portal works.
--
-- SELECT only, and only on the tables with a policy. The three link tables get
-- nothing, which is what section 4's closing note is about.

grant select on app.identity                to authenticated;
grant select on app.student                 to authenticated;
grant select on app.teacher                 to authenticated;
grant select on app.cohort                  to authenticated;
grant select on app.class_session           to authenticated;
grant select on app.class_session_teacher   to authenticated;
grant select on app.attendance_record       to authenticated;
grant select on app.creation                to authenticated;
grant select on app.organization            to authenticated;
grant select on app.organization_membership to authenticated;

-- anon gets nothing anywhere. A signed-out caller has no auth.uid(), so every
-- policy would return nothing regardless - but an explicit revoke means that is
-- true by grant as well as by policy, and does not depend on a helper returning
-- NULL to stay true.
revoke all on all tables in schema app from anon;

-- =============================================================================
-- 6. The first sign-in
-- =============================================================================
-- Called once, by the portal, immediately after Supabase Auth verifies the code.
-- It answers the question this whole task exists for: WHICH HUMAN IS THIS.
--
-- THE EMAIL COMES FROM THE JWT, NOT FROM A PARAMETER. This is the security
-- property of the function and the reason it takes no arguments. Supabase Auth
-- has just proved the caller controls that mailbox by sending a code to it; a
-- parameter would let any signed-in caller name any address and be linked to
-- that human.
--
-- EXACTLY ONE MATCH, OR NOTHING. Measured 8 Oct 2026 on live data:
--
--   app.student rows ................. 1,297
--   with no email at all ............. 17
--   addresses on more than one row ... 51, covering 123 rows
--   worst collision .................. 16 rows share a single address
--
-- So "find the student with this email" would have admitted one human to
-- another's data in 50 cases. It raises rather than guessing, and the caller is
-- expected to report every failure identically - a sign-in form that answers
-- differently for "no such address" is an oracle for who has an account.
--
-- IDEMPOTENT. A second call from the same auth user returns the same identity
-- rather than failing, because a retried request after a dropped response must
-- not read as a collision.

create or replace function app.link_signed_in_identity()
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_auth     uuid := auth.uid();
  v_email    text;
  v_identity uuid;
  v_matches  int;
begin
  if v_auth is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;

  -- Already linked? Return it. This is the common path on every sign-in after
  -- the first, and it must not touch the email at all.
  select i.id into v_identity
  from app.identity i
  where i.auth_user_id = v_auth;

  if found then
    return v_identity;
  end if;

  v_email := lower(trim(auth.jwt() ->> 'email'));
  if v_email is null or v_email = '' then
    raise exception 'no_email_claim' using errcode = '28000';
  end if;

  -- Candidates: humans with a STUDENT role whose student row carries this
  -- address. Teachers are excluded here rather than later - this function is the
  -- portal's door, and the portal is the student portal.
  select count(*), min(i.id)
    into v_matches, v_identity
  from app.identity i
  join app.student s on s.id = i.student_id
  where lower(trim(s.email)) = v_email;

  if v_matches <> 1 then
    -- Zero and many are the same refusal on purpose. They are different facts to
    -- an operator - RUNBOOK.md says what to do with each - and the same
    -- non-answer to a caller.
    raise exception 'no_single_identity_for_email' using errcode = '28000';
  end if;

  -- The claim itself. `auth_user_id is null` in the WHERE is what makes this
  -- safe under concurrency: two simultaneous first sign-ins race here, and the
  -- loser updates no row and raises, rather than overwriting the winner.
  update app.identity
     set auth_user_id = v_auth
   where id = v_identity
     and auth_user_id is null;

  if not found then
    raise exception 'identity_already_linked' using errcode = '28000';
  end if;

  return v_identity;
end
$$;

comment on function app.link_signed_in_identity() is
  'Links the signed-in auth user to exactly one identity, using the EMAIL CLAIM '
  'FROM THE JWT - never a parameter. Idempotent. Raises when the address matches '
  'zero or several students; the caller must report every failure identically.';

revoke execute on function app.link_signed_in_identity() from public;
grant execute on function app.link_signed_in_identity() to authenticated, service_role;

-- =============================================================================
-- 7. The raw payload tables
-- =============================================================================
-- DATA-MODEL.md: "raw_wl and raw_ghl have NO RLS enabled at all - only raw_link
-- does. They hold whole API responses for every client, so they are
-- service_role-only by intent and should be enabled to match."
--
-- Enabling RLS with no policy is the whole change. Nothing could read them
-- through PostgREST today either, but "nobody has been granted it" and "the row
-- security is on" fail differently the day somebody adds a convenience grant.
alter table public.raw_wl  enable row level security;
alter table public.raw_ghl enable row level security;

-- =============================================================================
-- Verification
-- =============================================================================
-- Read these. They are the shape of the thing, not proof that it isolates -
-- that is supabase/checks/portal_auth_isolation.sql, which signs two people in
-- and makes each of them fail to read the other.

-- The anchor is gone from person, and present on identity.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'person'
      and column_name = 'auth_user_id') as person_auth_user_id_columns_expect_0,
  (select count(*) from information_schema.columns
    where table_schema = 'app' and table_name = 'identity'
      and column_name = 'auth_user_id') as identity_auth_user_id_columns_expect_1;

-- Every policy this database now has.
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname in ('public', 'app')
order by schemaname, tablename, policyname;

-- Any table with RLS on and no policy is service_role-only. Expect the three
-- link tables, the raw payload tables, and the operational tables to be here -
-- and expect NOTHING the dashboard reads to be.
select n.nspname as schema, c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'app')
  and c.relkind = 'r'
  and c.relrowsecurity
  and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
order by 1, 2;

-- The helpers must all be SECURITY DEFINER with a pinned search_path. A false in
-- either column is the trap described in the header.
select p.proname,
       p.prosecdef as security_definer,
       coalesce(array_to_string(p.proconfig, ','), '(none - UNPINNED)') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'app'
  and p.proname in ('current_identity_id', 'current_student_id', 'current_wl_uid',
                    'current_org_ids', 'link_signed_in_identity')
order by p.proname;
