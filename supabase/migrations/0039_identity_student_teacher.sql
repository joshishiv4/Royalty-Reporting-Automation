-- =============================================================================
-- 0039  identity / student / teacher - the central record the portal reads
--
-- WHY THIS EXISTS
--   The student portal needs a human it can address that WellnessLiving does not
--   define. Today the only human here is `person`, keyed on WL's `uid`, which is
--   NOT NULL - so a student who signs up through the portal and has never been
--   entered into WL cannot be stored at all.
--
--   `identity` is that human. `student` and `teacher` are ROLES hanging off it.
--
-- WHY THIS IS NOT THE DESIGN 0001 REJECTED
--   DATA-MODEL.md records a rejected design: separate `client` and `teacher`
--   TABLES. It was rejected because all 20 records in /v1/staff/list carry both a
--   k_staff and a uid, and all 20 of those uids also resolve as clients - so two
--   unlinked tables count those 20 humans TWICE in royalties.
--
--   The hole is closed here by the hub, not by refusing to have role tables.
--   `identity` is the one row per human; a role is a pointer FROM it. The
--   rejected design had no hub, and that was the whole problem with it.
--
-- OURS HOLDS NO WELLNESSLIVING FIELD
--   `student` and `teacher` carry no uid, no k_staff, no k_login_type - nothing
--   from WL. Every WL key lives on `identity`, which is the mapping table and the
--   only place one belongs. The portal reads `student`; it never learns that
--   WellnessLiving exists.
--
--   This is a standing rule for every owned table, not a property of these two.
--
-- THE NAME COLLISION
--   A VIEW called `teacher` has existed since 0001 and was redefined by 0014. It
--   is the WL-shaped staff projection - k_staff, is_teaching, service_count - and
--   royalty reporting (M04b, not yet written) is the thing that will want it. It
--   is RENAMED to `wl_teacher` rather than dropped: dropping something because
--   the work that needs it has not started yet is a guess, and a cheap rename is
--   not.
--
--   `client` keeps its name. It does not collide with `student`, and it is read
--   by the RLS bypass check.
--
-- WHAT IS NOT HERE
--   The backfill and the triggers. They land together in 0040, deliberately:
--   a row inserted between a backfill and the trigger that was supposed to catch
--   it is lost with nothing to say so. These tables on their own are inert -
--   nothing reads them yet - so they are safe to ship alone.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- FIRST: rename the WL-shaped teacher view out of the way.
--
-- THIS MUST COME BEFORE `create table public.teacher`, AND THE FIRST DRAFT OF
-- THIS MIGRATION PUT IT LAST. That draft fails, and it fails QUIETLY at the point
-- it matters:
--
--   `create table IF NOT EXISTS public.teacher` sees a RELATION called teacher
--   already exists - the view - and skips, with only a notice. The table is never
--   created. `identity.teacher_id references public.teacher (id)` then points at
--   a view, and the first statement that treats teacher as a table fails with
--   42809 "teacher is not a table", several hundred lines from the cause.
--
--   IF NOT EXISTS does not mean "if no table of this name"; it means "if no
--   relation of this name". A view occupies the name just as firmly as a table.
--
-- Renamed rather than dropped and recreated: 0014's definition is the current one,
-- and restating it here would be a second copy to keep in step. A view is
-- rewritten whole, and STATUS.md records that this has already cost this project
-- twice.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_views where schemaname = 'public' and viewname = 'teacher'
  ) then
    execute 'alter view public.teacher rename to wl_teacher';
  end if;
end;
$$;

-- Belt and braces. If `teacher` is still a relation at this point it is something
-- this migration did not anticipate, and the failure should say so here rather
-- than surface as a confusing 42809 much further down.
do $$
begin
  if exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'teacher'
       and c.relkind <> 'r'
  ) then
    raise exception
      'public.teacher exists and is not a table (relkind %). 0039 expects the '
      'name to be free before it creates the teacher table.',
      (select c.relkind from pg_class c join pg_namespace n
         on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'teacher');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- student - a person who learns here. No WellnessLiving field.
-- -----------------------------------------------------------------------------
create table if not exists public.student (
  id            uuid        primary key default gen_random_uuid(),

  first_name    text,
  last_name     text,
  -- Contact detail is copied here rather than read through `person` because a
  -- portal-native student has no `person` row to read it from. For a student who
  -- came from WL these start as a copy and 0040's trigger keeps them current.
  email         varchar(255),
  phone         varchar(32),
  date_of_birth date,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.student is
  'A person who learns here. Carries NO WellnessLiving field - the portal reads '
  'this table and never learns that WellnessLiving exists. WL keys live on '
  'identity, which is the mapping table.';

-- -----------------------------------------------------------------------------
-- teacher - a person who teaches here. No WellnessLiving field either.
-- -----------------------------------------------------------------------------
-- Note what is ABSENT: k_staff, is_class, is_appointment, service_count. Those
-- are WellnessLiving facts and they stay on `person`, reachable through
-- identity.k_staff. The WL-shaped view is `wl_teacher`.
create table if not exists public.teacher (
  id            uuid        primary key default gen_random_uuid(),

  first_name    text,
  last_name     text,
  email         varchar(255),
  phone         varchar(32),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.teacher is
  'A person who teaches here. Carries NO WellnessLiving field. The WL-shaped '
  'staff projection is the wl_teacher view, which is a different thing and is '
  'what royalty reporting will want.';

-- -----------------------------------------------------------------------------
-- identity - ONE ROW PER HUMAN, and the only place a WL key may appear
-- -----------------------------------------------------------------------------
create table if not exists public.identity (
  id               uuid        primary key default gen_random_uuid(),

  -- ---------------------------------------------------------------------------
  -- WellnessLiving. NULLABLE, and that is the entire point of this table: a
  -- student who signed up in the portal has no uid and never will until WL is
  -- told about them.
  --
  -- ON DELETE SET NULL, not CASCADE. This row carries data that has nothing to do
  -- with WL - a portal student's progress, feedback and projects hang off it.
  -- Losing the WL mirror row must never destroy those. After the null, this
  -- identity is simply indistinguishable from a portal-native one: no schedule,
  -- no attendance, no purchases.
  --
  -- Nothing in this system deletes anyway - the sync is upsert-only and 0027
  -- settled that deactivated clients stay, with is_active carrying the status.
  -- So a person delete is an operator action, not a sync outcome.
  -- ---------------------------------------------------------------------------
  uid              text        references public.person (uid) on delete set null,

  -- THERE IS DELIBERATELY NO `uid_detached` HERE, AND THE REASON MATTERS.
  --
  -- A first draft carried one: the uid this row used to hold, kept when the
  -- person row goes away, so that a human WellnessLiving later returns re-links
  -- by an EXACT key instead of a phone-and-email guess that can park as
  -- ambiguous.
  --
  -- It cannot be filled. `on delete set null` NULLS the column; a foreign key
  -- cannot COPY the value somewhere first. Filling it needs a BEFORE DELETE
  -- trigger on person, and the instruction of 17 Sep 2026 is that there is no
  -- trigger on delete. A column that never fills is worse than a missing one,
  -- because task 030 would check it, find null, and conclude "no previous uid"
  -- when the truth is "never recorded".
  --
  -- Dropped by user decision, 17 Sep 2026. The cost is real and is recorded in
  -- Tasks/backlog/030: a WL re-link is now always the fuzzy match. It is judged
  -- affordable because nothing in this system deletes a person - the sync is
  -- upsert-only and 0027 settled that deactivated clients stay.

  -- The staff key, on the same row, exactly as person does it. Null means this
  -- human is not staff in WellnessLiving.
  k_staff          text,

  -- ---------------------------------------------------------------------------
  -- GoHighLevel. DELIBERATELY NOT UNIQUE - a family sharing one phone number
  -- resolves several people to the same contact. That is a correct result, not a
  -- collision, and a unique index here would look like tidying up and would
  -- silently break it. See the GoHighLevel section of DATA-MODEL.md.
  -- ---------------------------------------------------------------------------
  ghl_contact_id   text,

  -- The portal login. Null until this human signs up.
  auth_user_id     uuid,

  -- ---------------------------------------------------------------------------
  -- The roles. The links live HERE, on the hub, so one row answers everything
  -- about a human without a join.
  -- ---------------------------------------------------------------------------
  student_id       uuid        references public.student (id) on delete set null,
  teacher_id       uuid        references public.teacher (id) on delete set null,

  -- WL's business id. This is a WellnessLiving fact and belongs on the mapping
  -- table, never on student or teacher. Nullable, because a portal-native human
  -- does not belong to a WL business.
  k_business       text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz not null default now(),

  -- ---------------------------------------------------------------------------
  -- ONE HUMAN, ONE ROW - as a constraint, not as a convention.
  --
  -- The rule confirmed 17 Sep 2026 is that a teacher is a person WL marks with
  -- the staff profile type and EVERYONE ELSE is a student. Those are exclusive,
  -- so holding both roles is a bug rather than a case.
  --
  -- If that ever stops being true - a teacher who also enrols as a student - the
  -- change is dropping this one constraint, not a redesign.
  -- ---------------------------------------------------------------------------
  constraint identity_one_role_check check (
    student_id is null or teacher_id is null
  )
);

comment on table public.identity is
  'One row per human, and the ONLY table where a WellnessLiving key may appear. '
  'student and teacher hang off it as roles. Maintained by trigger from 0040 - '
  'no application code writes here.';
comment on column public.identity.uid is
  'WellnessLiving client id. NULLABLE on purpose: a student who signed up in the '
  'portal has none. ON DELETE SET NULL so losing the WL mirror never destroys '
  'portal-authored data hanging off this row.';
comment on column public.identity.ghl_contact_id is
  'NOT unique, deliberately. A family on one phone number resolves to one '
  'contact, and that is correct. See DATA-MODEL.md.';

-- -----------------------------------------------------------------------------
-- Uniqueness. Partial where the column is nullable, so many portal-native rows
-- can coexist with no uid while no two rows ever claim the same one.
-- -----------------------------------------------------------------------------
create unique index if not exists identity_uid_key
  on public.identity (uid) where uid is not null;

create unique index if not exists identity_k_staff_key
  on public.identity (k_staff) where k_staff is not null;

create unique index if not exists identity_auth_user_id_key
  on public.identity (auth_user_id) where auth_user_id is not null;

-- A role belongs to exactly one human. Without these, two identities could point
-- at one student row and the double-count this table exists to prevent walks
-- straight back in through the role instead of through the person.
create unique index if not exists identity_student_id_key
  on public.identity (student_id) where student_id is not null;

create unique index if not exists identity_teacher_id_key
  on public.identity (teacher_id) where teacher_id is not null;

-- Lookup paths the portal will actually use.
create index if not exists identity_ghl_contact_id_idx
  on public.identity (ghl_contact_id) where ghl_contact_id is not null;

-- -----------------------------------------------------------------------------
-- updated_at triggers - the 0006 convention.
--
-- A `default now()` fires only at INSERT, so a column defended by a default alone
-- reports the creation time forever and every "what changed recently" query is
-- quietly wrong.
-- -----------------------------------------------------------------------------
drop trigger if exists student_set_updated_at on public.student;
create trigger student_set_updated_at
  before update on public.student
  for each row execute function public.set_updated_at();

drop trigger if exists teacher_set_updated_at on public.teacher;
create trigger teacher_set_updated_at
  before update on public.teacher
  for each row execute function public.set_updated_at();

drop trigger if exists identity_set_updated_at on public.identity;
create trigger identity_set_updated_at
  before update on public.identity
  for each row execute function public.set_updated_at();

comment on view public.wl_teacher is
  'The WellnessLiving-shaped staff projection, defined by 0014 and renamed by '
  '0039 to free the name for the portal table. Keyed by login_type.is_teacher_type; '
  'is_teaching carries the older flag-based definition alongside it. This is what '
  'royalty reporting wants - the teacher TABLE is the portal-facing one and holds '
  'no WL field.';

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- On with no policies, so nothing is readable except through the service role.
-- 0001 put it this way for a reason worth repeating: a table that is open until
-- someone remembers to close it is open.
--
-- The portal's own read policies arrive with portal auth, not here. Nothing signs
-- in yet, so a policy written now would be written against a guess.
-- -----------------------------------------------------------------------------
alter table public.identity enable row level security;
alter table public.student  enable row level security;
alter table public.teacher  enable row level security;
