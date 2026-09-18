-- =============================================================================
-- 0043  attendance_record / attendance_link - who turned up, as the portal sees it
--
-- Same shape as 0039 and 0041: OURS holds no WellnessLiving field, the LINK holds
-- nothing else.
--
-- WHY attendance GETS A LINK WHEN AN EARLIER DRAFT SAID IT DID NOT
--   The first design of this argued attendance needed no link, because its WL key
--   (k_period, dt_start_utc, uid) is already resolvable - the occurrence through
--   session_link and the person through identity. That is true FOR MAPPING, and
--   it is the wrong conclusion, because mapping is not the only thing a link
--   carries.
--
--   The question the design has to answer is: DID THIS ATTENDANCE COME FROM
--   WELLNESSLIVING, OR WAS IT RECORDED IN THE PORTAL? Nothing in
--   (class_session_id, student_id) can answer it, and a portal-native student is
--   invisible to WellnessLiving by definition - so the two sources are real, not
--   hypothetical.
--
--   The invariant:
--       a link row  ->  WellnessLiving sent it
--       no link row ->  the portal recorded it
--
--   Provenance is DERIVED, never stored. A `source` column would be a second
--   place holding a fact the link already holds - exactly what 0001 refused when
--   it rejected an is_staff flag in favour of "a non-null k_staff is the answer".
--
--   And it buys a third thing neither mapping nor a source column would:
--   COLLISION DETECTION. If a session is marked attended in the portal and WL
--   later syncs the same attendance, two sources are claiming one fact. The link
--   is where that is caught; a source column would silently overwrite.
--
-- THE COST, STATED RATHER THAN DISCOVERED
--   This is the largest table in the design - one row per attendee per occurrence,
--   for ever, against 44,499 sessions as of 18 Sep 2026. 0044's backfill is
--   therefore SET-BASED, not the row-by-row loop 0040 and 0042 use: a loop over
--   several hundred thousand rows in the SQL editor is a statement timeout, not a
--   slow success.
--
-- DELETE BEHAVIOUR, unchanged from 17 Sep 2026: the WL side of the link is
-- ON DELETE SET NULL. The link row survives with its keys nulled and OUR row is
-- untouched.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- attendance_record - one student at one session. No WellnessLiving field.
-- -----------------------------------------------------------------------------
create table if not exists public.attendance_record (
  id               uuid        primary key default gen_random_uuid(),

  class_session_id uuid        not null
                   references public.class_session (id) on delete cascade,
  student_id       uuid        not null
                   references public.student (id) on delete cascade,

  -- ---------------------------------------------------------------------------
  -- The outcome, as booleans rather than one enum.
  --
  -- Kept in the shape `attendance` already uses, because 0029 established what
  -- WL's visit status means and src/sync/visit-outcome.ts is the ONE place that
  -- decides it. Re-modelling the answer here would be a second interpretation of
  -- the same source, and the two would disagree the first time WL added a status.
  -- ---------------------------------------------------------------------------
  --
  -- is_attended IS NULLABLE, AND THE FIRST DRAFT OF THIS FILE GOT IT WRONG.
  --
  -- It was written `not null default false`, which is exactly what `attendance`
  -- used to be and exactly what 0029 removed. That migration's reasoning applies
  -- here word for word: "`not null default false` asserted that every visit was
  -- not attended until proven otherwise. For a session that has not happened, or
  -- one WL has marked PENDING for staff to decide, that is a claim we cannot
  -- make - and it is the claim a royalty is calculated against."
  --
  -- The error that caught it was a not-null violation on the backfill. The
  -- tempting fix was `coalesce(is_attended, false)`, and it would have been worse
  -- than the error: it converts "we have no idea" into "they did not turn up",
  -- silently, in the column the portal shows a student as their attendance record.
  is_attended         boolean,
  is_no_show          boolean  not null default false,
  is_cancelled_client boolean  not null default false,
  is_cancelled_studio boolean  not null default false,
  is_late_cancel      boolean  not null default false,
  is_waitlisted       boolean  not null default false,

  booked_at        timestamptz,
  checked_in_at    timestamptz,
  cancelled_at     timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One row per student per session. Both halves are OURS, which is the point:
  -- the WL key never appears here, and this is still the natural key.
  constraint attendance_record_natkey_unique unique (class_session_id, student_id)
);

comment on table public.attendance_record is
  'One student at one session. Carries NO WellnessLiving field - both halves of '
  'its key are ours. A row WITHOUT an attendance_link row was recorded in the '
  'portal rather than synced; presence of the link is the provenance, so no '
  'source column exists to disagree with it.';

create index if not exists attendance_record_student_idx
  on public.attendance_record (student_id);
create index if not exists attendance_record_session_idx
  on public.attendance_record (class_session_id);

-- -----------------------------------------------------------------------------
-- attendance_link - (k_period, dt_start_utc, uid) <-> attendance_record
-- -----------------------------------------------------------------------------
create table if not exists public.attendance_link (
  id                   uuid        primary key default gen_random_uuid(),

  -- WellnessLiving's key, all three parts. ON DELETE SET NULL: losing the mirror
  -- row must never take our row with it, and a student's portal-recorded
  -- attendance is not WellnessLiving's to remove.
  k_period             text,
  dt_start_utc         timestamptz,
  uid                  text,
  k_business           text,

  attendance_record_id uuid
                       references public.attendance_record (id) on delete set null,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  synced_at            timestamptz not null default now(),

  constraint attendance_link_attendance_fkey
    foreign key (k_period, dt_start_utc, uid)
    references public.attendance (k_period, dt_start_utc, uid) on delete set null
);

comment on table public.attendance_link is
  'Maps a WellnessLiving attendance row to an attendance_record. Holds WL keys '
  'and nothing else. Its EXISTENCE is the provenance: an attendance_record with '
  'no row here was recorded in the portal. It is also where a portal-then-WL '
  'collision is caught instead of silently overwritten.';

create unique index if not exists attendance_link_natkey_unique
  on public.attendance_link (k_period, dt_start_utc, uid)
  where k_period is not null;

create unique index if not exists attendance_link_record_id_key
  on public.attendance_link (attendance_record_id)
  where attendance_record_id is not null;

-- -----------------------------------------------------------------------------
-- updated_at triggers - the 0006 convention.
-- -----------------------------------------------------------------------------
drop trigger if exists attendance_record_set_updated_at on public.attendance_record;
create trigger attendance_record_set_updated_at
  before update on public.attendance_record
  for each row execute function public.set_updated_at();

drop trigger if exists attendance_link_set_updated_at on public.attendance_link;
create trigger attendance_link_set_updated_at
  before update on public.attendance_link
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security. On with no policies - nothing readable except through the
-- service role. The portal's read policies arrive with portal auth; writing one
-- now would be writing it against a guess.
-- -----------------------------------------------------------------------------
alter table public.attendance_record enable row level security;
alter table public.attendance_link   enable row level security;
