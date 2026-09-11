-- =============================================================================
-- 0014  login_type reference table, and the teacher definition it now drives
--
-- WHAT CHANGED, AND WHY IT IS A BUSINESS DECISION NOT A TECHNICAL ONE
--   0001 defined a teacher as "person with a non-null k_staff", with is_teaching
--   (is_class or is_appointment or is_event) marking who actually teaches. The
--   studio has since confirmed the rule they use: a teacher is a person whose WL
--   LOGIN TYPE is "Staff Client Profile" (k_login_type 1260510 on the live
--   business). That is their call to make, and this migration implements it.
--
--   Measured against live dev data 24 Aug 2026, the two definitions AGREE on 15
--   of 20 people and DISAGREE on five. Recorded here because the disagreement is
--   the interesting part and will otherwise be rediscovered:
--
--     login type says teacher, no teaching flag set:
--       Finance Team, Admin SpinDJAcademy, Pau Leogo (billing), Ian Berk
--     teaches (appointments) but a different login type:
--       Cameron Escovedo  -- "Monthly Subscription Client"
--
--   So the login-type rule counts four admin/finance accounts as teachers and
--   omits one person WL says takes appointments. The studio was shown this and
--   confirmed the rule anyway. is_teaching is KEPT on the view so the
--   disagreement stays queryable rather than being argued about from memory.
--
-- WHY A TABLE AND NOT `where k_login_type = '1260510'`
--   That key is data about ONE business. Hard-coding it in a view would break
--   the moment a second business is synced, and would put a business fact in a
--   place nobody thinks to look. Login types are reference data like promotions
--   and shop categories - WL serves all thirteen from /v1/login/type - so they
--   get a table, and WHICH ONE MEANS TEACHER is one boolean on it, changeable
--   with an UPDATE rather than a deploy.
--
-- Safe to re-run.
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- login_type - the thirteen client types WL serves from /v1/login/type
-- -----------------------------------------------------------------------------
create table if not exists public.login_type (
  k_login_type     text        primary key,
  k_business       text        not null,

  title            text,
  -- WL's own grouping. Observed: 1 = Prospect, 2 = non-member, 3 = member.
  -- Kept as WL sends it; an enum would reject a value we have not seen.
  id_client_type   integer,
  -- WL sends null for the Prospect type, so this is deliberately nullable -
  -- "not a member" and "membership does not apply" are different facts.
  is_member        boolean,

  -- ---------------------------------------------------------------------------
  -- The teacher rule, as DATA. Exactly one type is expected to carry this per
  -- business, but no constraint enforces that: a studio that splits teachers
  -- across two login types should be able to say so with an UPDATE, not a
  -- migration.
  -- ---------------------------------------------------------------------------
  is_teacher_type  boolean     not null default false,

  -- The 0006 convention: created_at (first seen here), synced_at (last fetched),
  -- updated_at (last CHANGED here, maintained by the trigger below).
  created_at       timestamptz not null default now(),
  synced_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.login_type is
  'WL client/login types, synced from /v1/login/type. Thirteen on the live '
  'business, exactly the count the All Clients report offers as its filter.';
comment on column public.login_type.is_teacher_type is
  'Which login type means "teacher" for this business. Set by the studio, not '
  'derived. Changing who counts as a teacher is an UPDATE here, not a deploy.';

drop trigger if exists login_type_set_updated_at on public.login_type;
create trigger login_type_set_updated_at
  before update on public.login_type
  for each row execute function public.set_updated_at();

create index if not exists login_type_teacher_idx
  on public.login_type (k_business) where is_teacher_type;

-- -----------------------------------------------------------------------------
-- Seed the studio's confirmed rule.
--
-- ORDER-INDEPENDENT ON PURPOSE. A plain UPDATE would silently affect zero rows
-- when this migration is applied BEFORE the first login-type sync, leaving the
-- teacher view empty with nothing to explain why - the failure would look like
-- "no teachers synced" rather than "the flag was never set". So this inserts the
-- row if the sync has not created it yet and flags it either way.
--
-- k_business is taken from the person table rather than written in: the business
-- id is configuration (WL_K_BUSINESS), and a migration is not where it should
-- first appear. If no person rows exist yet this inserts nothing - and at that
-- point there is nobody to be a teacher, so the view being empty is correct.
-- Re-run this migration after the first sync and it will complete the seed.
-- -----------------------------------------------------------------------------
insert into public.login_type (k_login_type, k_business, title, is_teacher_type)
select '1260510', b.k_business, 'Staff Client Profile', true
  from (select distinct k_business from public.person) b
    on conflict (k_login_type) do update
   set is_teacher_type = true;

-- -----------------------------------------------------------------------------
-- teacher - now defined by login type
-- -----------------------------------------------------------------------------
-- k_staff is NOT required any more. It stays on the view because royalty
-- reporting joins on it, but a person the studio types as a teacher is a teacher
-- here whether or not WL also gave them a staff record - that gap (eight people
-- carry this login type in the WL report and never appear in /v1/staff/list) is
-- the enumeration blocker, not a reason to filter them out once we can see them.
drop view if exists public.teacher;

create view public.teacher
  with (security_invoker = on) as
  select p.k_staff, p.uid, p.k_business, p.first_name, p.last_name, p.email, p.phone,
         p.k_login_type, p.text_login_type,
         p.is_class, p.is_appointment, p.is_event, p.service_count,
         -- Kept deliberately: this is the OLD definition, and where it disagrees
         -- with the login type is where someone is being paid who does not teach,
         -- or teaches without being paid. Five such rows exist on dev today.
         (p.is_class or p.is_appointment or p.is_event) as is_teaching,
         -- created_at, NOT first_seen_at: 0006 renamed that column and the
         -- 0001 view definition this was adapted from is stale.
         p.created_at, p.synced_at
    from public.person p
    join public.login_type lt
      on lt.k_login_type = p.k_login_type
     and lt.k_business   = p.k_business
   where lt.is_teacher_type;

comment on view public.teacher is
  'People the studio types as teachers - login_type.is_teacher_type, confirmed '
  '24 Aug 2026 as "Staff Client Profile". is_teaching carries the older '
  'flag-based definition alongside it; the two disagree on five of twenty live, '
  'so a row where they differ is worth a human look before it earns a royalty.';
