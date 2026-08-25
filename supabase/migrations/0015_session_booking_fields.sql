-- =============================================================================
-- 0015  session: the booking fields the schedule list actually returns
--
-- 0004 modelled the session and got the hard part right - the primary key is
-- (k_period, dt_start_utc), because a class id repeats every week. That was
-- designed before anything could fetch a schedule, so it guessed at which
-- booking fields WL would send.
--
-- Probed live 25 Aug 2026, /v1/schedule/class/list returns per occurrence:
--   i_book, i_capacity, i_wait, is_event, is_cancel, is_virtual,
--   is_wait_list_enabled, url_book, i_duration, dt_date, dtl_date,
--   text_timezone, k_class, k_class_period, k_location, s_title,
--   a_staff (k_staff) and a_staff_uid (person uid)
--
-- i_book -> i_booked and i_capacity already exist. The five below did not.
--
-- THE REPEAT TRAP, CONFIRMED ON REAL DATA
--   k_class_period 18448467 came back SIX times in one 38-day window - one row
--   per week, same id, different date. Keyed on the id alone, five of the six
--   would have overwritten each other and the studio would be paid for one
--   class instead of six. The 0004 key already prevents this; recorded here
--   because it is now measured rather than anticipated.
--
-- WHY url_book IS STORED EVEN THOUGH IT CONTAINS A HOST
--   Hosts must not appear in SOURCE - that is about configuration leaking into
--   code. This is a URL WL generated and handed us as data, tied to one
--   occurrence, and the portal needs to link a student straight to it. Dropping
--   it would mean rebuilding it from parts, which is exactly the re-derivation
--   this schema avoids elsewhere.
-- =============================================================================

alter table public.session
  add column if not exists i_wait               integer,
  add column if not exists is_event             boolean not null default false,
  add column if not exists is_virtual           boolean not null default false,
  add column if not exists is_wait_list_enabled boolean not null default false,
  add column if not exists url_book             text;

comment on column public.session.i_wait is
  'How many are on the waitlist for THIS occurrence. Live: 0 on every session '
  'observed, but the field is real and separate from capacity.';
comment on column public.session.is_event is
  'WL sends this as the STRING "0" / "1", not a boolean. Parsed on the way in.';
comment on column public.session.is_wait_list_enabled is
  'Whether a waitlist is offered at all - distinct from i_wait being zero. '
  '"Nobody waiting" and "no waitlist exists" are different facts.';
comment on column public.session.url_book is
  'WL-generated booking link for this occurrence, stored as sent. It carries '
  'the class period and start time, so it cannot be shared between weeks.';

-- Sessions are read by "what is on this week", which is a date-range scan
-- across the whole business, not a lookup by class.
create index if not exists session_start_idx
  on public.session (k_business, dt_start_utc);
