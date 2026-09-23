-- =============================================================================
-- 0048  organization / organization_membership
--
-- Spin DJ Academy becomes Organization #1 instead of being the whole system.
-- This is NOT multi-tenancy. Nothing here onboards a provider, switches an
-- organization, or bills one. It makes the FIRST organization explicit so that
-- a second one is a row rather than a schema rewrite.
--
-- TWO NEW TABLES, and `organization_id` on the SEVEN application tables. The
-- WellnessLiving mirror is left alone entirely, and so are the three link
-- tables - see below.
--
-- -----------------------------------------------------------------------------
-- THIS FILE LIVES IN `app`, AND MUST RUN AFTER 0047
--
--   0047 creates the `app` schema and moves the eleven portal-owned tables into
--   it. Everything here is portal-owned too, so `organization` and
--   `organization_membership` are created in `app` directly rather than created
--   in public and moved afterwards - there is no history to preserve, so there
--   is nothing to migrate.
--
--   `public.person` is still public: it is the WellnessLiving mirror, and the
--   seed below reads `k_business` from it across the schema boundary, which is
--   the normal case rather than a special one.
--
--   `public.organization_stamp()` is public because every projection function
--   is. Their bodies address `app`, their triggers sit on whichever table owns
--   the row, and keeping them in one schema is what makes "where is this
--   defined" answerable without a search. See 0047 section 3.
--
-- -----------------------------------------------------------------------------
-- WHY NOTHING IS ADDED TO THE MIRROR OR THE LINK TABLES
--
--   `k_business` already sits on 23 mirror tables and already holds one value,
--   '334942', on every row - 1,292 people, 44,793 sessions, 22,787 purchases.
--   It is a tenant discriminator in practice. It is also WELLNESSLIVING'S key,
--   and a second organization must not have to own a WellnessLiving account in
--   order to exist. So it is not renamed, not copied, and not promoted.
--
--   `cohort_link`, `session_link` and `attendance_link` carry nothing but the
--   provenance of one owned row. Their organization is whatever their owned row
--   says it is; a column here would be a second answer to that question, and
--   the two would eventually disagree.
--
--   WL-shaped rows therefore resolve their organization through
--   `organization.wl_k_business`. A column, not a mapping table. When a second
--   integration system needs its own tenant key the column becomes a table -
--   that is a later migration, and it is cheap because nothing joins through it
--   yet.
--
-- -----------------------------------------------------------------------------
-- WHY MEMBERSHIP POINTS AT `identity` AND NOT AT `person`
--
--   A naming collision worth stating, because the wrong reading here produces
--   the wrong table. In this schema `person` is the WELLNESSLIVING MIRROR: its
--   `uid` is WL's and is NOT NULL, so a human WL has never heard of cannot have
--   a `person` row at all. `identity` (0039) is the canonical human - one row
--   per person, `uid` NULLABLE precisely so a portal-native human exists.
--
--   Membership hangs off `identity`. Hanging it off `person` would mean only
--   people WellnessLiving knows about can belong to an organization, which
--   reintroduces the coupling this migration exists to remove.
--
-- -----------------------------------------------------------------------------
-- WHY `identity` GETS NO `organization_id`
--
--   It is the mapping row - the one table a WL key may appear on - and it is
--   the canonical human. The same human may later be a participant at one
--   provider and a teacher at another. An `organization_id` column on the human
--   is a single-org assumption wearing a different hat, so organization and
--   role live together on the membership, where both can repeat.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- organization
-- -----------------------------------------------------------------------------
-- Singular, like every other table here (`person`, `student`, `cohort`), not
-- `organizations`. The convention is not decoration: `raw_link.table_name`
-- stores table names as data, so a table named differently from its neighbours
-- is a lookup that silently misses.
create table if not exists app.organization (
  id            uuid        primary key default gen_random_uuid(),

  -- A stable, human-readable handle so code and configuration can name an
  -- organization WITHOUT embedding its uuid. The uuid is generated, so it
  -- differs between dev and production; a literal uuid in source is a hardcoded
  -- environment, which tests/no-hardcoded-config exists to prevent.
  slug          text        not null,
  name          text        not null,

  -- WellnessLiving's k_business for this organization, where it has one.
  -- NULLABLE and that is the point: a future organization with no WellnessLiving
  -- account is a normal case, not a broken row.
  wl_k_business text,

  -- Soft, because an organization that stops trading still owns its history.
  -- Deleting it would orphan every class, attendance and file it ever had.
  is_active     boolean     not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint organization_slug_unique unique (slug)
);

-- Unique only WHERE PRESENT: two organizations may both have no WL account, but
-- two organizations claiming the same WellnessLiving business would make every
-- derived row ambiguous - and ambiguity here is silent, resolving to whichever
-- row came back first.
create unique index if not exists organization_wl_k_business_unique
  on app.organization (wl_k_business)
  where wl_k_business is not null;

comment on table app.organization is
  'A provider. Spin DJ Academy is the first and, for V1, the only one. Exists '
  'so that a second provider is an INSERT rather than a schema change.';

-- -----------------------------------------------------------------------------
-- organization_membership - which humans belong to an organization, and as what
-- -----------------------------------------------------------------------------
-- A human is not OWNED by an organization; they have a relationship with one, it
-- has a kind, and it can end. All three are properties of the relationship, not
-- of the human, which is why none of them is a column on `identity`.
create table if not exists app.organization_membership (
  id              uuid        primary key default gen_random_uuid(),

  organization_id uuid        not null
                  references app.organization (id) on delete restrict,

  -- The canonical human. See the header: `identity`, never `person`.
  identity_id     uuid        not null
                  references app.identity (id) on delete cascade,

  -- TEXT with a CHECK rather than an enum, because a role added later must not
  -- require an ALTER TYPE while rows are being written.
  role            text        not null,

  -- A membership that ended is kept, not deleted: the attendance and payments it
  -- explains are still there, and a row that vanishes makes that history
  -- unattributable.
  status          text        not null default 'active',

  -- Dates, not timestamps. When somebody joined a school is a calendar fact.
  started_on      date,
  ended_on        date,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint organization_membership_role_check
    check (role in ('participant', 'teacher', 'parent', 'broker', 'admin')),

  constraint organization_membership_status_check
    check (status in ('active', 'invited', 'ended')),

  -- An end date before the start is not a case, it is a typo.
  constraint organization_membership_dates_check
    check (ended_on is null or started_on is null or ended_on >= started_on)
);

comment on table app.organization_membership is
  'One human''s relationship with one organization, in one role. A human may '
  'hold several: participant at one provider and teacher at another is the case '
  'this table exists for. Points at identity, not person, because person '
  'requires a WellnessLiving uid.';

-- One ACTIVE membership per (organization, human, role). Partial rather than a
-- plain unique constraint, so somebody who left and came back gets a second row
-- rather than having their history overwritten - the same shape as
-- sync_queue_active_target_key.
create unique index if not exists organization_membership_active_unique
  on app.organization_membership (organization_id, identity_id, role)
  where status = 'active';

create index if not exists organization_membership_identity_idx
  on app.organization_membership (identity_id)
  where status = 'active';

create index if not exists organization_membership_org_role_idx
  on app.organization_membership (organization_id, role)
  where status = 'active';

drop trigger if exists organization_set_updated_at on app.organization;
create trigger organization_set_updated_at
  before update on app.organization
  for each row execute function public.set_updated_at();

drop trigger if exists organization_membership_set_updated_at
  on app.organization_membership;
create trigger organization_membership_set_updated_at
  before update on app.organization_membership
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Seed: Spin DJ Academy is Organization #1
-- =============================================================================
-- Keyed on `slug`, so re-running does not mint a second Spin.
insert into app.organization (slug, name)
values ('spin-dj-academy', 'Spin DJ Academy')
    on conflict (slug) do nothing;

-- The WellnessLiving business is READ FROM THE DATA, never written as a literal:
-- the value is configuration, and tests/no-hardcoded-config holds src/ and api/
-- to exactly this rule. An empty database maps nothing rather than inventing a
-- business that does not exist.
update app.organization o
   set wl_k_business = d.k_business
  from (select distinct k_business
          from public.person
         where k_business is not null) as d
 where o.slug = 'spin-dj-academy'
   and o.wl_k_business is distinct from d.k_business;

-- =============================================================================
-- organization_id on the seven application tables
-- =============================================================================
-- Added nullable here and made NOT NULL at the end of this file, once the
-- backfill has run and the stamp trigger below guarantees new rows carry one.
-- Adding it NOT NULL in one step would fail on the 44,793 rows already present.
alter table app.student               add column if not exists organization_id uuid;
alter table app.teacher               add column if not exists organization_id uuid;
alter table app.cohort                add column if not exists organization_id uuid;
alter table app.class_session         add column if not exists organization_id uuid;
alter table app.class_session_teacher add column if not exists organization_id uuid;
alter table app.attendance_record     add column if not exists organization_id uuid;
alter table app.creation              add column if not exists organization_id uuid;

-- ON DELETE RESTRICT throughout: an organization with a single class, student or
-- uploaded file must not be deletable. Losing a provider should be a deliberate
-- migration of its data, never a cascade nobody watched.
do $$
declare
  t text;
begin
  foreach t in array array[
    'student', 'teacher', 'cohort', 'class_session',
    'class_session_teacher', 'attendance_record', 'creation'
  ]
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = t || '_organization_id_fkey'
         and conrelid = ('app.' || t)::regclass
    ) then
      execute format(
        'alter table app.%I add constraint %I
           foreign key (organization_id) references app.organization (id)
           on delete restrict',
        t, t || '_organization_id_fkey');
    end if;

    execute format(
      'create index if not exists %I on app.%I (organization_id)',
      t || '_organization_idx', t);
  end loop;
end
$$;

-- =============================================================================
-- The stamp: new rows get an organization without the sync knowing about one
-- =============================================================================
-- WHY A TRIGGER AND NOT A CHANGE TO 0042 / 0044.
--   Four of these seven tables are written by the projection functions, which
--   have fourteen trigger cases passing against them. Threading an organization
--   through those functions means editing code that currently resolves a teacher
--   through `identity` and a session through `session_link` - and every one of
--   those paths would need a new argument. A BEFORE INSERT trigger fills the
--   column without any of that, so the sync keeps working unchanged.
--
-- WHY `into strict` AND NOT A DEFAULT.
--   A DEFAULT would have to name Spin, which hardcodes Organization #1 into the
--   schema - the exact assumption this migration removes. `select ... into
--   strict` raises NO_DATA_FOUND when there is no organization and TOO_MANY_ROWS
--   when there are two. So the day a second organization is created, every
--   insert that did not say which one FAILS LOUDLY instead of silently filing a
--   second provider's class under Spin.
--
--   That error is the point. It is a build-time reminder, delivered at the exact
--   moment the assumption stops being true, that the writer now has to choose.
create or replace function public.organization_stamp()
returns trigger
language plpgsql
as $$
declare
  v_org uuid;
begin
  if new.organization_id is null then
    select id into strict v_org
      from app.organization
     where is_active;

    new.organization_id := v_org;
  end if;

  return new;
end;
$$;

comment on function public.organization_stamp() is
  'Fills organization_id on an application row that did not name one. Raises '
  'rather than guessing once a second organization exists - see 0048.';

do $$
declare
  t text;
begin
  foreach t in array array[
    'student', 'teacher', 'cohort', 'class_session',
    'class_session_teacher', 'attendance_record', 'creation'
  ]
  loop
    execute format('drop trigger if exists %I on app.%I',
                   t || '_organization_stamp', t);
    execute format(
      'create trigger %I before insert on app.%I
         for each row execute function public.organization_stamp()',
      t || '_organization_stamp', t);
  end loop;
end
$$;

-- =============================================================================
-- Backfill: every existing row belongs to Spin, explicitly
-- =============================================================================
-- Requirement 6, and the reason the column is made NOT NULL below: ownership is
-- written down, never inferred from a null. "NULL means Spin" is exactly the
-- implicit hardcoding this migration exists to delete, and it would survive the
-- arrival of Organization #2 as a silent wrong answer.
--
-- Driven by a NULL check, so re-running repairs a gap and does nothing on a
-- healthy database - the property 0045 is built on.
do $$
declare
  t text;
  v_org uuid;
  n bigint;
begin
  select id into v_org from app.organization where slug = 'spin-dj-academy';

  if v_org is null then
    raise exception '0048: Spin organization missing - the seed above did not run';
  end if;

  foreach t in array array[
    'student', 'teacher', 'cohort', 'class_session',
    'class_session_teacher', 'attendance_record', 'creation'
  ]
  loop
    execute format(
      'update app.%I set organization_id = $1 where organization_id is null',
      t) using v_org;
    get diagnostics n = row_count;
    -- A backfill that repaired 44,793 rows silently is indistinguishable from
    -- one that repaired none.
    raise notice '0048: %  organization_id backfilled on % row(s)', t, n;
  end loop;
end
$$;

-- Membership for every human we already know about. The role comes from the FK
-- `identity` already carries, which is the current source of truth for who is a
-- teacher (`login_type.is_teacher_type`, 0014) - deriving from it keeps this
-- migration from inventing a second answer to a question the schema answers.
insert into app.organization_membership
  (organization_id, identity_id, role, status)
select o.id,
       i.id,
       case when i.teacher_id is not null then 'teacher' else 'participant' end,
       'active'
  from app.identity i
 cross join app.organization o
 where o.slug = 'spin-dj-academy'
   and not exists (
     select 1 from app.organization_membership m
      where m.identity_id = i.id
        and m.organization_id = o.id
        and m.status = 'active'
   );

-- An identity with NEITHER role is a stub whose login type has not landed yet
-- (0040 leaves it so deliberately). It is backfilled as 'participant', the same
-- default the projection uses. The membership role does NOT yet self-correct
-- when 0040 later sorts that person into `teacher` - see docs/DATA-MODEL.md.
-- Making it self-correct is what turns membership into the source of truth for
-- role, and that is a follow-up, not this migration.

-- =============================================================================
-- NOT NULL, now that every row has one and every new row gets one
-- =============================================================================
-- This is what makes ownership unambiguous rather than merely usual. Without it
-- a writer that forgets the column produces a row owned by nobody, and nothing
-- says so until a query quietly returns short.
alter table app.student               alter column organization_id set not null;
alter table app.teacher               alter column organization_id set not null;
alter table app.cohort                alter column organization_id set not null;
alter table app.class_session         alter column organization_id set not null;
alter table app.class_session_teacher alter column organization_id set not null;
alter table app.attendance_record     alter column organization_id set not null;
alter table app.creation              alter column organization_id set not null;

do $$
declare
  v_org int;
  v_mem int;
begin
  select count(*) into v_org from app.organization;
  select count(*) into v_mem from app.organization_membership;
  raise notice '0048: % organization(s), % membership(s)', v_org, v_mem;
end
$$;

-- =============================================================================
-- Row Level Security
-- =============================================================================
-- Enabled, deliberately WITHOUT policies, which means service_role only.
--
-- That is correct right now and not an oversight: `identity.auth_user_id` is
-- null on all 1,292 rows, and so is `person.auth_user_id`. Nobody has ever
-- authenticated against this database, so a policy written now would be written
-- against a shape no request has ever taken and could be checked by nothing but
-- inspection.
--
-- The org-scoped policies belong in the migration that also wires portal login.
-- What that migration needs is written down in docs/DATA-MODEL.md so it is not
-- rediscovered.
alter table app.organization            enable row level security;
alter table app.organization_membership enable row level security;
