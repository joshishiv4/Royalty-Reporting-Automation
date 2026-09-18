-- =============================================================================
-- 0041  cohort / class_session - the schedule the portal reads
--
-- Same shape as 0039: OURS holds no WellnessLiving field, a LINK table holds
-- nothing else, and the link is what joins them. The portal reads `cohort` and
-- `class_session` and never learns that WellnessLiving exists.
--
-- WHY THE LINK IS NOT OPTIONAL HERE EITHER
--   It would have been enough to hang a nullable `k_period` on class_session.
--   The rule that our tables carry no WL field rules that out, and a second
--   reason arrives with it: PRESENCE OF A LINK IS THE PROVENANCE. A session with
--   a link row came from WellnessLiving; one without was created in the portal.
--   Nothing extra is stored, so nothing can drift out of step with it - the same
--   reason 0001 refused an `is_staff` flag in favour of "k_staff is not null".
--
-- WL COMPRESSES TWO LEVELS INTO ONE TABLE, AND WE NEED BOTH
--   0004 says it plainly: "A CLASS ID REPEATS. k_class 268302 is 'A Joyful Noise
--   | 60 Minutes' every week forever, so it identifies the class, not the
--   occurrence." So WL has:
--       the series     -> k_class, A COLUMN. There is no class table.
--       the occurrence -> session, PK (k_period, dt_start_utc)
--   The dashboard needs both: a class group ("Podcasting Group 1") and a single
--   dated session. `cohort` is the level WellnessLiving has no key for.
--
-- WHY cohort_link HAS NO FOREIGN KEY AND session_link DOES
--   `session` is a real table with a real primary key, so session_link points at
--   it. `k_class` is only a column on that table - nothing is unique on it - so
--   there is nothing for cohort_link to reference. That is not an oversight in
--   this migration; it is the shape of the source.
--
-- DELETE BEHAVIOUR, as decided 17 Sep 2026 and unchanged here
--   The WL side of a link is ON DELETE SET NULL. The link row survives with its
--   keys nulled, and OUR row is untouched. A portal-authored session note must
--   never disappear because somebody removed a class in WellnessLiving. Nothing
--   in this system deletes anyway - the sync is upsert-only.
--
-- LOCAL TIME IS STORED AS SENT, NOT DERIVED. 0004 measured why: WL returns
-- `text_timezone` as "ET", an ABBREVIATION. It does not say whether EST or EDT
-- was in force and Postgres cannot convert with it, so the local value is
-- impossible to re-derive. A class is also scheduled in local wall time -
-- "Tuesday 6pm" stays 6pm across a daylight-saving change while its UTC value
-- moves - so the wall time is the business fact, not a rendering of the UTC one.
--
-- WHAT IS NOT HERE
--   attendance_record and its link. No dashboard section reads attendance, and
--   it is the largest table in this design - one row per attendee per occurrence,
--   for ever. It gets its own migration once its cost has been measured.
--
--   program and organization. They have NO WellnessLiving source and never will,
--   so they cannot be projected from anything - they are authored data and
--   belong with the work that decides who authors them.
--
--   The backfill and the triggers. They land together in 0042, for the reason
--   0040 gives: a row inserted between a backfill and the trigger meant to catch
--   it is lost with nothing to say so.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- cohort - a class group. The level WellnessLiving has no key for.
-- -----------------------------------------------------------------------------
create table if not exists public.cohort (
  id            uuid        primary key default gen_random_uuid(),

  title         text,

  -- ---------------------------------------------------------------------------
  -- AUTO-STUBBED COHORTS ARE COUNTABLE, and that is the whole point of the flag.
  --
  -- A WL session may carry a k_class nobody has mapped. Refusing it would leave
  -- the student's next session invisible until an admin did data entry, which
  -- fails the stated requirement outright ("if WellnessLiving shows it, the
  -- portal shows it"). So 0042 creates a placeholder and carries on.
  --
  -- A placeholder that cannot be told from a real one is how a temporary row
  -- becomes permanent. `is_resolved` is false until a human names it, exactly as
  -- 0012 does for `service`.
  -- ---------------------------------------------------------------------------
  is_resolved   boolean     not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.cohort is
  'A class group - the level WellnessLiving has no key for (k_class is a column '
  'on session, not a table). Carries NO WellnessLiving field; the mapping is in '
  'cohort_link. is_resolved false means 0042 stubbed it from a class nobody has '
  'named yet.';

-- -----------------------------------------------------------------------------
-- class_session - one dated occurrence. No WellnessLiving field.
-- -----------------------------------------------------------------------------
create table if not exists public.class_session (
  id               uuid        primary key default gen_random_uuid(),

  cohort_id        uuid        references public.cohort (id) on delete set null,

  title            text,

  -- The instant. Fully described by UTC.
  starts_at        timestamptz not null,
  ends_at          timestamptz,

  -- ---------------------------------------------------------------------------
  -- The wall time, AS SENT. `timestamp` WITHOUT a zone, matching the source
  -- column, and deliberately not timestamptz: making it an instant would require
  -- a zone to interpret it, and the only zone WL gives is "ET" - which cannot be
  -- resolved to EST or EDT. See the header.
  -- ---------------------------------------------------------------------------
  local_start      timestamp,
  local_end        timestamp,
  -- WL's own label, e.g. "ET". NOT an IANA zone name. Kept so a reader can see
  -- what we were told rather than what we guessed; do not feed it to a converter.
  timezone_label   text,

  duration_minutes integer,
  capacity         integer,
  booked_count     integer,

  is_cancelled     boolean     not null default false,

  -- "class" or "appointment". WellnessLiving keeps both in one table because to
  -- a royalty calculation they are the same event - somebody taught, somebody
  -- attended, at a time - and that reasoning holds here too.
  kind             text,

  location_title   text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.class_session is
  'One dated occurrence of a class or appointment. Carries NO WellnessLiving '
  'field - the mapping is in session_link, and a row with no link row was '
  'created in the portal rather than synced.';
comment on column public.class_session.local_start is
  'Wall time as WellnessLiving sent it, zone-less on purpose. The only zone WL '
  'supplies is an abbreviation ("ET") that cannot be resolved to EST or EDT, so '
  'this is impossible to re-derive from starts_at and must be stored.';

create index if not exists class_session_starts_at_idx
  on public.class_session (starts_at);
create index if not exists class_session_cohort_idx
  on public.class_session (cohort_id);

-- -----------------------------------------------------------------------------
-- class_session_teacher - who taught it
-- -----------------------------------------------------------------------------
-- A JOIN TABLE, NOT A COLUMN ON class_session. WellnessLiving allows several
-- staff on one occurrence and flags substitutes, so a single teacher_id would
-- silently pick one and lose the rest. The dashboard shows one name today; that
-- is a choice the API makes from complete data, not a choice the schema makes
-- for it.
--
-- No link table of its own: both sides already resolve: the occurrence through
-- session_link and the person through identity.
create table if not exists public.class_session_teacher (
  id               uuid        primary key default gen_random_uuid(),

  class_session_id uuid        not null
                   references public.class_session (id) on delete cascade,
  teacher_id       uuid        not null
                   references public.teacher (id) on delete cascade,

  is_substitute    boolean     not null default false,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint class_session_teacher_natkey_unique unique (class_session_id, teacher_id)
);

comment on table public.class_session_teacher is
  'Who taught an occurrence. A join table because WellnessLiving allows several '
  'staff per session and flags substitutes - a single column would drop them.';

-- -----------------------------------------------------------------------------
-- cohort_link - k_class <-> cohort. No foreign key; see the header.
-- -----------------------------------------------------------------------------
create table if not exists public.cohort_link (
  id          uuid        primary key default gen_random_uuid(),

  -- WellnessLiving's series key. Nothing is unique on session.k_class, so there
  -- is no relation to reference - this is a recorded value, not an enforced one.
  k_class     text,
  k_business  text,

  cohort_id   uuid        references public.cohort (id) on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  synced_at   timestamptz not null default now()
);

comment on table public.cohort_link is
  'Maps WellnessLiving k_class to a cohort. Holds WL keys and nothing else. No '
  'foreign key on k_class because session.k_class is a plain column - WL has no '
  'class table to point at.';

create unique index if not exists cohort_link_natkey_unique
  on public.cohort_link (k_class, k_business)
  where k_class is not null;

create unique index if not exists cohort_link_cohort_id_key
  on public.cohort_link (cohort_id) where cohort_id is not null;

-- -----------------------------------------------------------------------------
-- session_link - (k_period, dt_start_utc) <-> class_session
-- -----------------------------------------------------------------------------
create table if not exists public.session_link (
  id               uuid        primary key default gen_random_uuid(),

  -- ---------------------------------------------------------------------------
  -- WellnessLiving's occurrence key, both halves. ON DELETE SET NULL, matching
  -- identity: losing the mirror row must never take our row with it. Both
  -- columns null together, which is what a composite SET NULL does.
  -- ---------------------------------------------------------------------------
  k_period         text,
  dt_start_utc     timestamptz,
  k_business       text,

  class_session_id uuid        references public.class_session (id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz not null default now(),

  constraint session_link_session_fkey
    foreign key (k_period, dt_start_utc)
    references public.session (k_period, dt_start_utc) on delete set null
);

comment on table public.session_link is
  'Maps a WellnessLiving occurrence to a class_session. Holds WL keys and '
  'nothing else. A class_session WITHOUT a row here was created in the portal - '
  'presence of the link is the provenance, so no source column is needed.';

create unique index if not exists session_link_natkey_unique
  on public.session_link (k_period, dt_start_utc)
  where k_period is not null;

create unique index if not exists session_link_class_session_id_key
  on public.session_link (class_session_id) where class_session_id is not null;

-- -----------------------------------------------------------------------------
-- updated_at triggers - the 0006 convention. A `default now()` fires only at
-- INSERT, so a column defended by a default alone reports the creation time for
-- ever and every "what changed recently" query is quietly wrong.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'cohort', 'class_session', 'class_session_teacher', 'cohort_link', 'session_link'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I '
      'for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security. On with no policies, so nothing is readable except through
-- the service role. 0001 put it this way for a reason worth repeating: a table
-- that is open until someone remembers to close it is open.
--
-- The portal's read policies arrive with portal auth. Writing one now would be
-- writing it against a guess, because nothing signs in yet.
-- -----------------------------------------------------------------------------
alter table public.cohort                enable row level security;
alter table public.class_session         enable row level security;
alter table public.class_session_teacher enable row level security;
alter table public.cohort_link           enable row level security;
alter table public.session_link          enable row level security;
