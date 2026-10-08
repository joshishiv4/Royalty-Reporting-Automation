-- =============================================================================
-- 0054  One definition of "is this address on the roll", used at both ends of
--       the sign-in
--
-- WHY THIS EXISTS
--   `0053` shipped a working door with no key cut for it. Measured 8 Oct 2026,
--   against live, through the portal's own sign-in form:
--
--     POST /auth/v1/otp  ->  422 otp_disabled
--                            "Signups not allowed for otp"
--     auth.users ......... 0 rows
--
--   The sign-in rule in task 028 reads "a code is sent only to an address
--   already in the database". The database it means is `app.student`. The table
--   Supabase Auth checks under `shouldCreateUser: false` is `auth.users`, and
--   NOTHING IN THE FLOW HAS EVER WRITTEN TO IT. So every student is refused
--   before an email is attempted, and the refusal is indistinguishable - by
--   design - from the unconfigured SMTP everyone assumed was the cause.
--
--   The portal now provisions the auth user itself, but only for an address the
--   roll already admits. That check has to be the SAME check the link performs
--   at verification time, or the two drift and the portal mails a code to
--   somebody it will then refuse to sign in.
--
-- SO: the matching rule moves out of `link_signed_in_identity()` into
--   `identity_for_email()`, and the link calls it. One statement of the rule,
--   two callers. `link_signed_in_identity()` keeps its exceptions - the caller
--   contract from 0053 is unchanged and `portal_auth_isolation.sql` section E
--   still exercises it.
--
-- WHY THE NEW FUNCTION RETURNS NULL RATHER THAN RAISING
--   The OTP route asks this question about an address nobody has authenticated
--   as. "Zero matches" is a routine answer there, not an error, and it must cost
--   the caller exactly what "one match" costs - the same 202, the same work. An
--   exception would be caught and discarded on every unknown address, which is
--   how timing differences and stray log lines turn a sign-in form into an
--   oracle for who has an account.
--
-- WHO MAY CALL IT
--   `service_role` ONLY. This function answers "does this address exist on the
--   roll", which is the exact fact the uniform 202 exists to withhold. Granting
--   it to `authenticated` would hand any signed-in student a membership probe
--   for every address they can think of. The link function reaches it as
--   SECURITY DEFINER, not through a grant.
--
-- Safe to re-run.
-- =============================================================================

-- =============================================================================
-- 1. The rule, stated once
-- =============================================================================
-- Lifted verbatim from 0053's `link_signed_in_identity()`, including the two
-- things about it that are not obvious:
--
--   * The join to `app.student` is what restricts this to STUDENTS. An identity
--     with only a teacher role has no `student_id` and cannot match. This is the
--     student portal's door; 0053 put it that way deliberately and this move
--     must not quietly widen it.
--
--   * `(array_agg(i.id))[1]` rather than `min(i.id)`. PostgreSQL ships no
--     min/max AGGREGATE for uuid - the type has btree ordering, so `min(id)`
--     reads as though it must work, but the call resolves to nothing and raises
--     42883 at runtime. `check_function_bodies` does not resolve functions
--     called inside a plpgsql body's SQL statements, so the broken version
--     created cleanly and failed on every first sign-in. Section E of
--     portal_auth_isolation.sql is what caught it.
--
--     Which of several rows would be taken is not a question worth asking: the
--     count test below refuses anything but exactly one.

create or replace function app.identity_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 1 then (array_agg(i.id))[1] end
  from app.identity i
  join app.student s on s.id = i.student_id
  where lower(trim(s.email)) = lower(trim(p_email));
$$;

comment on function app.identity_for_email(text) is
  'The single identity whose student row carries this address, or NULL when zero '
  'or several do. NULL is an answer, not an error - the caller must treat "no '
  'such address" and "ambiguous address" identically. service_role only: this '
  'answers whether an address is on the roll, which is what the sign-in form''s '
  'uniform reply exists to withhold.';

revoke execute on function app.identity_for_email(text) from public;
revoke execute on function app.identity_for_email(text) from authenticated, anon;
grant execute on function app.identity_for_email(text) to service_role;

-- =============================================================================
-- 2. The link, now calling it
-- =============================================================================
-- Unchanged in contract: same name, same empty parameter list, same errcode
-- 28000 on every refusal, still idempotent, still reading the email from the JWT
-- claim and never from an argument. Only the matching paragraph is gone, into
-- the function above.
--
-- THE FUNCTION STILL TAKES NO PARAMETERS, AND STILL MUST NOT. It reads the email
-- from the claim Supabase Auth has just verified by sending a code to it. An
-- email parameter would let any signed-in caller name any address and be linked
-- to that person. That `identity_for_email()` now takes an address as an
-- argument does not weaken this: the argument below comes from the JWT, and the
-- grant above means a signed-in student cannot reach the new function directly.

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

  v_identity := app.identity_for_email(v_email);

  if v_identity is null then
    -- Zero and many are the same refusal on purpose. They are different facts to
    -- an operator - RUNBOOK.md §10a says what to do with each - and the same
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
  'zero or several students; the caller must report every failure identically. '
  'The matching rule itself is app.identity_for_email() (0054).';

revoke execute on function app.link_signed_in_identity() from public;
grant execute on function app.link_signed_in_identity() to authenticated, service_role;

-- =============================================================================
-- Verification
-- =============================================================================
-- Read these. Isolation is still portal_auth_isolation.sql's job, and section E
-- of it exercises the link through this refactor unchanged.

-- Both functions SECURITY DEFINER with a pinned search_path. A false, or an
-- unpinned config, is the trap 0053's header describes.
select p.proname,
       p.prosecdef as security_definer,
       coalesce(array_to_string(p.proconfig, ','), '(none - UNPINNED)') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'app'
  and p.proname in ('identity_for_email', 'link_signed_in_identity')
order by p.proname;

-- Who may execute the new one. Expect service_role and the owner, and expect
-- NEITHER `authenticated` NOR `anon` to appear.
select r.rolname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'app'
  and p.proname = 'identity_for_email'
  and has_function_privilege(r.rolname, p.oid, 'execute')
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

-- How many addresses the roll will admit, and how many it will refuse. These
-- are the numbers RUNBOOK §10a is written against; if the second or third has
-- grown, the operator work has grown with it.
select
  count(*) filter (where n = 1) as addresses_admitted,
  count(*) filter (where n > 1) as addresses_ambiguous_refused,
  (select count(*) from app.student
    where email is null or trim(email) = '') as students_with_no_address
from (
  select lower(trim(s.email)) as e, count(*) as n
  from app.identity i
  join app.student s on s.id = i.student_id
  where s.email is not null and trim(s.email) <> ''
  group by 1
) t;
