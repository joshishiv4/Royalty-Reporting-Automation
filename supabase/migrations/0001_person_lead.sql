-- =============================================================================
-- 0001  person / lead
--
-- ONE HUMAN, ONE ROW. WellnessLiving keys staff and clients separately, so a
-- person who both teaches and takes classes has two identifiers. Verified live
-- against the UAT host on 19 Aug 2026: every one of the 20 records in
-- /v1/staff/list carries BOTH a k_staff (6 digits) and a uid (8 digits), and
-- all 20 of those uids also resolve as clients via /v1/user. Split across two
-- tables those 20 humans would be counted twice in royalties, so both ids live
-- on the same row.
--
-- THE JOIN IS FREE. WL puts the client uid directly onto the staff record, so
-- no matching heuristic is needed - k_staff and uid arrive together in one call.
--
-- ABOUT THE TWO VIEWS. The ticket asks for client and teacher tables AND for a
-- single row carrying both ids, which pull in opposite directions. The row wins,
-- because that is the criterion with a reason attached (double counting). The
-- views give `client` and `teacher` as things you can select from without
-- storing the same fact twice.
--
-- WHAT DOES *NOT* IDENTIFY A TEACHER
--   - client type. Of the 20 staff, 17 are "Staff Client Profile" and 3 are not
--     (2 "Monthly Subscription Client", 1 "Prospect"), while 47 clients carry
--     that type. It over-counts by 27 and under-counts by 3. Label only.
--   - the teaching flags alone. 6 of the 20 have no flags and 0 services
--     (Finance Team, Admin, Operations and similar), but they ARE staff. They
--     are stored, and the royalty query filters on the flags - a WHERE clause,
--     not a migration, when the definition changes.
--
-- ALL WELLNESSLIVING KEYS ARE text. They arrive as JSON strings and k_ values
-- are documented as text everywhere (PRD M02). As integers a leading zero is
-- lost and a 6-digit key compares equal to nothing useful.
-- =============================================================================

create table if not exists public.person (
  -- The client identifier. Present for every human WL knows about.
  uid              text        primary key,
  k_business       text        not null,

  -- ---------------------------------------------------------------------------
  -- The staff identifier, ON THE SAME ROW. Null for someone who only takes
  -- classes. unique so one human can never hold two staff records.
  -- ---------------------------------------------------------------------------
  k_staff          text        unique,

  -- What this person is set up to do. Meaningless unless k_staff is set, so the
  -- constraint below keeps them from drifting apart.
  is_class         boolean     not null default false,
  is_appointment   boolean     not null default false,
  is_event         boolean     not null default false,
  service_count    integer     not null default 0
                   constraint person_service_count_check check (service_count >= 0),

  constraint person_staff_fields_need_k_staff check (
    k_staff is not null
    or (is_class = false and is_appointment = false and is_event = false and service_count = 0)
  ),

  -- ---------------------------------------------------------------------------
  -- Contact
  -- ---------------------------------------------------------------------------
  first_name       text,
  last_name        text,
  email            varchar(255),
  -- Phones arrive ALREADY in full international format: every one of the 19
  -- samples observed began with "+", in two shapes - "+NNNNNNNNNNN" (12) and
  -- "+NNNN-NNN-NNNN" (14). 32 leaves room for a longer country code or an
  -- extension without a migration.
  phone            varchar(32),
  phone_home       varchar(32),
  phone_work       varchar(32),
  date_of_birth    date,

  -- ---------------------------------------------------------------------------
  -- Client type. Label only - see the header.
  -- ---------------------------------------------------------------------------
  k_login_type     text,
  text_login_type  text,

  -- The "Client ID #" shown in the WL UI. NOT the uid: observed as 9 digits for
  -- one person and "" for another, and only returned by
  -- /v1/login/search/staff-app/list, never by /v1/user.
  text_member      text,

  -- ---------------------------------------------------------------------------
  -- GoHighLevel (PRD M04)
  -- ---------------------------------------------------------------------------
  ghl_contact_id   text,
  ghl_match_state  text        not null default 'unmatched'
    constraint person_ghl_match_state_check
    check (ghl_match_state in ('unmatched', 'matched', 'ambiguous', 'failed')),

  first_seen_at    timestamptz not null default now(),
  synced_at        timestamptz not null default now()
);

comment on table public.person is
  'One row per human. Carries the client id (uid) and, when they also work here, '
  'the staff id (k_staff) - both on the same row, so nobody is counted twice.';
comment on column public.person.k_staff is
  'Staff identifier, on the same row as uid. Null means this person is not staff.';
comment on column public.person.text_login_type is
  'Display label only. Never use it to decide who teaches - it over-counts by 27 '
  'and under-counts by 3 against /v1/staff/list.';

create index if not exists person_k_business_idx on public.person (k_business);
create index if not exists person_email_idx on public.person (lower(email));
create index if not exists person_ghl_match_state_idx on public.person (ghl_match_state)
  where ghl_match_state <> 'matched';
-- Partial: only rows that are actually staff.
create index if not exists person_staff_idx on public.person (k_business)
  where k_staff is not null;
-- Supports the royalty query: who actually teaches.
create index if not exists person_teaching_idx on public.person (k_business)
  where k_staff is not null and (is_class or is_appointment or is_event);
-- text_member is optional, so uniqueness is enforced only where it exists.
create unique index if not exists person_text_member_key
  on public.person (k_business, text_member)
  where text_member is not null and text_member <> '';

-- -----------------------------------------------------------------------------
-- lead - captured before the person exists
-- -----------------------------------------------------------------------------
-- A lead has NO uid: it is a form submission, not yet an account. When it
-- converts, WL creates a client (type "Prospect", k_login_type 1234074) and the
-- uid is filled in here.
--
-- SCOPE, stated honestly: /v1/lead/info returns only the FORM DEFINITION, not
-- lead records, and as of 19 Aug 2026 no endpoint lists leads. This table cannot
-- be populated from the WL API yet. It exists so a capture path has somewhere to
-- write and so a converted lead can be tied to its person.
--
-- The form is business-configurable. Observed here: 4 fields, keyed 299334 First
-- name, 299335 Last name, 299332 Email, 299336 Phone Number. The k_field values
-- are stored with the data because another business - or this one after an edit -
-- uses different keys for the same meaning.
create table if not exists public.lead (
  id               uuid        primary key default gen_random_uuid(),
  k_business       text        not null,

  first_name       text,
  last_name        text,
  email            varchar(255),
  phone            varchar(32),

  k_field_map      jsonb       not null default '{}'::jsonb,
  extra_fields     jsonb       not null default '{}'::jsonb,

  uid              text        references public.person (uid) on delete set null,
  converted_at     timestamptz,

  source           text,

  ghl_contact_id   text,
  ghl_match_state  text        not null default 'unmatched'
    constraint lead_ghl_match_state_check
    check (ghl_match_state in ('unmatched', 'matched', 'ambiguous', 'failed')),

  created_at       timestamptz not null default now(),
  synced_at        timestamptz not null default now(),

  -- A converted lead must say when, and an unconverted one must not.
  constraint lead_converted_together
    check ((uid is null) = (converted_at is null))
);

create index if not exists lead_k_business_idx on public.lead (k_business);
create index if not exists lead_email_idx on public.lead (lower(email));
create index if not exists lead_unconverted_idx on public.lead (k_business)
  where uid is null;

-- -----------------------------------------------------------------------------
-- Views - `client` and `teacher` without storing anything twice
-- -----------------------------------------------------------------------------
create or replace view public.client as
  select uid, k_business, first_name, last_name, email, phone, phone_home,
         phone_work, date_of_birth, k_login_type, text_login_type, text_member,
         ghl_contact_id, ghl_match_state, first_seen_at, synced_at
  from public.person;

-- Every staff record from /v1/staff/list, teaching or not. Filter on the flags
-- for the royalty-bearing subset.
create or replace view public.teacher as
  select k_staff, uid, k_business, first_name, last_name, email, phone,
         is_class, is_appointment, is_event, service_count,
         (is_class or is_appointment or is_event) as is_teaching,
         first_seen_at, synced_at
  from public.person
  where k_staff is not null;

comment on view public.teacher is
  'Staff subset of person. is_teaching marks the 14 of 20 with at least one '
  'teaching flag; the other 6 are real staff with no classes (admin, finance).';

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
-- On with no policies, so nothing is readable except through the service role
-- the sync workers use. The portal (M02) reads this same database, and a table
-- that is open until someone remembers to close it is open.
alter table public.person enable row level security;
alter table public.lead   enable row level security;
