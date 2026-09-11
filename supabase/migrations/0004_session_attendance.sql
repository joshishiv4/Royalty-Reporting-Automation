-- =============================================================================
-- 0004  session / session_staff / attendance
--
-- A CLASS ID REPEATS. k_class 268302 is "A Joyful Noise | 60 Minutes" every week
-- forever, so it identifies the class, not the occurrence. The occurrence is the
-- class plus its date, which is exactly how WL addresses one:
--   /v1/schedule/class/view?k_class_period=18448467&dt_date=2026-08-19 00:00:00
-- so the primary key here is (k_period, dt_start_utc).
--
-- BOTH SHAPES, ONE TABLE. A private appointment and a class are the same thing
-- to a royalty calculation - someone taught, someone attended, at a time. They
-- differ only in which WL key names the series, so `session_kind` says which and
-- `k_period` holds it. k_class and k_appointment are kept alongside for
-- provenance, with a constraint that the right one is populated.
--
-- WHY LOCAL TIME IS STORED, NOT DERIVED
-- Observed verbatim from /v1/schedule/class/list:
--   {"dt_date":"2026-09-07 04:00:00","dtl_date":"2026-09-07 00:00:00",
--    "text_timezone":"ET"}
-- WL sends UTC, local, and a timezone - but the timezone is "ET", an
-- ABBREVIATION, not an IANA name like America/New_York. "ET" cannot be resolved:
-- it does not say whether EST or EDT was in force, and Postgres cannot convert
-- with it. So the local value is impossible to re-derive from what WL gives us,
-- and is stored as sent.
--
-- There is a second reason, independent of the first. A class is scheduled in
-- LOCAL wall time - "Tuesday 6pm" stays 6pm across a daylight-saving change
-- while its UTC value shifts by an hour. The wall time is the business fact.
--
-- (This differs from 0002, where purchases keep UTC only. A purchase is an
-- instant, and an instant is fully described by UTC. A scheduled session is not.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- session - one occurrence of a class or an appointment
-- -----------------------------------------------------------------------------
create table if not exists public.session (
  -- WL's key for the SERIES: k_class_period for a class, k_appointment for an
  -- appointment. Which one is in here is named by session_kind.
  k_period         text        not null,
  -- UTC start. Half of the key, because the series repeats.
  dt_start_utc     timestamptz not null,

  k_business       text        not null,
  k_location       text        references public.location (k_location) on delete set null,

  session_kind     text        not null
    constraint session_kind_check check (session_kind in ('class', 'appointment')),

  -- Provenance. Exactly one is set, matching session_kind.
  k_class          text,
  k_appointment    text,
  constraint session_key_matches_kind check (
    (session_kind = 'class'       and k_class is not null and k_appointment is null)
    or (session_kind = 'appointment' and k_appointment is not null and k_class is null)
  ),

  -- ---------------------------------------------------------------------------
  -- Times. UTC, the local value WL sent, and WL's timezone label for it.
  -- The local column is NOT derived - see the header.
  -- ---------------------------------------------------------------------------
  dtl_start_local  timestamp   not null,
  dt_end_utc       timestamptz,
  dtl_end_local    timestamp,
  -- As WL sends it, e.g. "ET". An abbreviation, not an IANA zone: kept for
  -- display and for reconciling against WL, never used to convert.
  text_timezone    text,

  text_title       text,
  i_duration_min   integer,
  i_capacity       integer,
  i_booked         integer,

  -- ---------------------------------------------------------------------------
  -- CANCELLATION IS TWO FACTS, NOT ONE FLAG
  -- The studio cancelling a class and a client dropping out are different
  -- events with different royalty consequences: a studio cancellation earns
  -- nobody anything, while a late client cancellation is often still billable.
  -- One boolean would force a rule to be guessed at read time.
  -- ---------------------------------------------------------------------------
  is_cancelled_studio boolean  not null default false,
  dt_cancelled_studio_utc timestamptz,
  -- Set when every booked client cancelled, as distinct from the studio pulling
  -- the session. Per-client detail lives on attendance.
  is_cancelled_client boolean  not null default false,

  first_seen_at    timestamptz not null default now(),
  synced_at        timestamptz not null default now(),

  -- The class repeats; the occurrence does not.
  constraint session_pkey primary key (k_period, dt_start_utc)
);

comment on table public.session is
  'One occurrence. Keyed on the WL series key plus the UTC start, because a '
  'class id repeats every week and cannot identify an occurrence on its own.';
comment on column public.session.dtl_start_local is
  'The local value WL returned (dtl_*), stored as sent. Not derivable: WL sends '
  'the timezone as an abbreviation such as "ET", which does not resolve.';
comment on column public.session.is_cancelled_studio is
  'Studio pulled the session. Separate from client cancellation on purpose - '
  'they bill differently.';

create index if not exists session_business_start_idx
  on public.session (k_business, dt_start_utc);
create index if not exists session_location_idx on public.session (k_location);
create index if not exists session_class_idx on public.session (k_class)
  where k_class is not null;
create index if not exists session_appointment_idx on public.session (k_appointment)
  where k_appointment is not null;
-- The royalty query: sessions that actually ran.
create index if not exists session_live_idx on public.session (k_business, dt_start_utc)
  where not is_cancelled_studio;

-- -----------------------------------------------------------------------------
-- session_staff - who taught it
-- -----------------------------------------------------------------------------
-- Its own table because a session can have more than one: the observed
-- /v1/schedule/class/view returns a_staff as an ARRAY, and each entry carries
-- is_substitute and is_quick_substitute. A single k_staff column on session
-- could not record a substitute at all, and the substitute is precisely the
-- person a royalty is owed to.
create table if not exists public.session_staff (
  k_period         text        not null,
  dt_start_utc     timestamptz not null,
  -- Observed: {"k_staff":868220,"uid":"63746599","is_substitute":false}. Both
  -- ids come back, so both are recorded - k_staff is the assignment, uid ties it
  -- to the person row.
  k_staff          text        not null,
  uid              text        references public.person (uid) on delete set null,

  is_substitute       boolean  not null default false,
  is_quick_substitute boolean  not null default false,
  s_position       text,

  synced_at        timestamptz not null default now(),

  constraint session_staff_pkey primary key (k_period, dt_start_utc, k_staff),
  constraint session_staff_session_fkey
    foreign key (k_period, dt_start_utc)
    references public.session (k_period, dt_start_utc) on delete cascade
);

create index if not exists session_staff_k_staff_idx on public.session_staff (k_staff);
create index if not exists session_staff_uid_idx on public.session_staff (uid);

-- -----------------------------------------------------------------------------
-- attendance - who was booked, and what became of it
-- -----------------------------------------------------------------------------
create table if not exists public.attendance (
  k_period         text        not null,
  dt_start_utc     timestamptz not null,
  uid              text        not null references public.person (uid) on delete restrict,

  k_business       text        not null,
  -- WL's own visit key when it supplies one, for reconciling back.
  k_visit          text,

  -- Booking time, same three-column treatment as the session.
  dt_booked_utc    timestamptz,
  dtl_booked_local timestamp,
  text_timezone    text,

  -- ---------------------------------------------------------------------------
  -- Outcome. Attended, cancelled by whom, or simply absent - and the two
  -- cancellations stay apart for the same reason as on session.
  -- ---------------------------------------------------------------------------
  is_attended      boolean     not null default false,
  is_no_show       boolean     not null default false,
  is_cancelled_client boolean  not null default false,
  is_cancelled_studio boolean  not null default false,
  dt_cancelled_utc    timestamptz,
  dtl_cancelled_local timestamp,
  -- A cancellation inside the studio's notice window. Usually still billable,
  -- which is why it is a fact of its own rather than a subtype of cancelled.
  is_late_cancel   boolean     not null default false,

  first_seen_at    timestamptz not null default now(),
  synced_at        timestamptz not null default now(),

  constraint attendance_pkey primary key (k_period, dt_start_utc, uid),
  constraint attendance_session_fkey
    foreign key (k_period, dt_start_utc)
    references public.session (k_period, dt_start_utc) on delete cascade,
  -- Attended and cancelled cannot both be true; nor can both cancellations.
  constraint attendance_outcome_exclusive check (
    not (is_attended and (is_cancelled_client or is_cancelled_studio))
    and not (is_cancelled_client and is_cancelled_studio)
  )
);

comment on column public.attendance.is_late_cancel is
  'Cancelled inside the notice window. Usually still billable, so it is kept '
  'separate from a plain cancellation rather than inferred from a timestamp.';

create index if not exists attendance_uid_idx on public.attendance (uid);
create index if not exists attendance_business_start_idx
  on public.attendance (k_business, dt_start_utc);
-- The royalty query: who actually turned up.
create index if not exists attendance_attended_idx
  on public.attendance (k_business, dt_start_utc)
  where is_attended;

alter table public.session       enable row level security;
alter table public.session_staff enable row level security;
alter table public.attendance    enable row level security;
