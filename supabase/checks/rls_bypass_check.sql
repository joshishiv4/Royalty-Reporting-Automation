-- =============================================================================
-- RLS bypass check - read-only, changes nothing
--
-- "Is RLS bypassed" has three different answers in Postgres, and only one of
-- them would be a bug:
--
--   1. BY DESIGN. Supabase's service_role carries the BYPASSRLS attribute, and
--      superusers bypass unconditionally. The sync workers use service_role, so
--      this is the mechanism working, not failing.
--
--   2. THE TABLE OWNER. RLS does NOT apply to the table's owner unless the table
--      is also set to FORCE ROW LEVEL SECURITY. Our tables are owned by
--      `postgres`, which is a superuser anyway - so this changes nothing here,
--      but it matters the moment a non-superuser owns a table.
--
--   3. A VIEW WITHOUT security_invoker. THIS is the real bug. A view runs with
--      its OWNER's privileges by default, so selecting from it reads straight
--      past the policies on the table underneath. `client` and `teacher` read
--      `person`, so if either lost security_invoker, RLS on person would be
--      decorative.
--
-- Sections 5 and 6 are the ones that actually prove something: they switch role
-- and count rows, rather than reading catalogue flags and inferring.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. RLS on, and is it forced?
-- -----------------------------------------------------------------------------
-- relrowsecurity = RLS enabled.  relforcerowsecurity = applies to the owner too.
select
  c.relname                as table_name,
  c.relrowsecurity         as rls_enabled,
  c.relforcerowsecurity    as forced_for_owner,
  pg_get_userbyid(c.relowner) as owner
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, c.relname;

-- -----------------------------------------------------------------------------
-- 2. Policies. Currently expected to be ZERO - and that is the finding, not a
--    pass. RLS with no policies means normal roles see NOTHING, including their
--    own rows, so the student portal would render empty.
-- -----------------------------------------------------------------------------
select schemaname, tablename, policyname, roles, cmd, qual
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- -----------------------------------------------------------------------------
-- 3. Views: does each one defer to the CALLER? Any 'OFF' here is a real bypass.
-- -----------------------------------------------------------------------------
select
  c.relname as view_name,
  coalesce(
    (select option_value from pg_options_to_table(c.reloptions)
     where option_name = 'security_invoker'),
    'OFF - BYPASSES RLS on the underlying table'
  ) as security_invoker,
  pg_get_userbyid(c.relowner) as owner
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
order by c.relname;

-- -----------------------------------------------------------------------------
-- 4. Which roles bypass RLS outright, whatever the policies say.
-- -----------------------------------------------------------------------------
select rolname, rolbypassrls, rolsuper
from pg_roles
where rolname in ('postgres', 'service_role', 'authenticated', 'anon', 'authenticator')
order by rolbypassrls desc, rolname;

-- -----------------------------------------------------------------------------
-- 5. THE ACTUAL TEST, as anon. Counts rows rather than trusting a flag.
-- -----------------------------------------------------------------------------
-- Expect 0 for every table. A non-zero count means anon can read personal data.
-- A "permission denied" error instead means anon has no SELECT grant at all,
-- which is also fine - stricter, in fact.
begin;
set local role anon;

select 'anon' as acting_as,
       (select count(*) from public.person)    as person_rows,
       (select count(*) from public.lead)      as lead_rows,
       (select count(*) from public.purchase)  as purchase_rows,
       (select count(*) from public.attendance) as attendance_rows,
       (select count(*) from public.raw_wl)    as raw_wl_rows;

-- The views are the interesting part: if security_invoker is off, these return
-- rows even though the table above returned none.
select 'anon via views' as acting_as,
       (select count(*) from public.client)  as client_rows,
       (select count(*) from public.teacher) as teacher_rows;

rollback;

-- -----------------------------------------------------------------------------
-- 6. Same, as authenticated. This is the role the student portal will use.
-- -----------------------------------------------------------------------------
-- Expect 0 everywhere today, because there are no policies. That is exactly why
-- the portal cannot work yet: with no policy, `authenticated` cannot see its OWN
-- rows either.
begin;
set local role authenticated;

select 'authenticated' as acting_as,
       (select count(*) from public.person)    as person_rows,
       (select count(*) from public.purchase)  as purchase_rows,
       (select count(*) from public.attendance) as attendance_rows;

select 'authenticated via views' as acting_as,
       (select count(*) from public.client)  as client_rows,
       (select count(*) from public.teacher) as teacher_rows;

rollback;

-- -----------------------------------------------------------------------------
-- 7. Table-level grants. RLS filters rows; grants decide whether a role may ask
--    at all. Both matter, and only one of them is RLS.
-- -----------------------------------------------------------------------------
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
group by table_name, grantee
order by table_name, grantee;
