-- =============================================================================
-- 0029  id_visit: what WellnessLiving actually says happened
--
-- Fixes a misread that emptied the royalty signal, and closes the "no
-- cancellation is reported" gap. Both were the same mistake: the one field that
-- carries the outcome was never read.
--
-- -----------------------------------------------------------------------------
-- WHAT WAS WRONG
-- -----------------------------------------------------------------------------
-- attendance.is_attended was written from session.is_checkin. The API documents
-- is_checkin as:
--
--   "If true, then this visit is READY TO BE checked in. If false, then this
--    visit CAN'T be checked in."
--
-- That is a capability, not an outcome - whether the check-in button is live,
-- not whether anybody walked in. Measured on live dev 27 Aug 2026:
--
--   session.is_checkin = true        0 of 4,423
--   attendance.is_attended = true    4 of 4,431
--   is_cancelled_client = true       0
--   is_cancelled_studio = true       0
--   session_outcome                  988 'upcoming', 12 'unknown', 0 countable
--
-- So the royalty attendance signal was not merely wrong, it was empty, and
-- is_attended's `not null default false` made "we have no idea" indistinguishable
-- from "they did not turn up".
--
-- -----------------------------------------------------------------------------
-- WHAT ACTUALLY REPORTS THE OUTCOME
-- -----------------------------------------------------------------------------
-- id_visit, returned by /v1/schedule/page/element and documented as "the status
-- of the visit", one of the WlVisitSid constants:
--
--   1 BOOK      Active reservation - the client is going to attend
--   2 WAIT      On the wait list
--   3 ATTEND    Client has attended the session
--   4 PENALTY   Client has cancelled his reservation TOO LATE
--   5 TRUANCY   Client has missed the session WITHOUT cancelling
--   6 CANCEL    Client has cancelled in time and without penalty
--   7 PENDING   Registered, but ATTEND/TRUANCY/PENALTY is not yet decided -
--               "the real type of this visit must be set manually by staff"
--   8 REMOVE    Removed; hidden everywhere in WL but kept in their database
--
-- WHY NOBODY FOUND THIS. The API docs link the enum as Wl/Visit/VisitSid.php,
-- which does not exist - the file is Wl/Visit/WlVisitSid.php. Every attempt to
-- read the constants 404'd, so the endpoint's own field list said "one of the
-- VisitSid constants" and the constants were unreachable.
--
-- SO CANCELLATION *IS* REPORTED - as a status (4 or 6), and a late cancellation
-- is told apart from a timely one. What is genuinely NOT published anywhere in
-- the 208-path spec is a cancellation TIMESTAMP. dt_cancel is the cancel-by
-- deadline and is already correctly named dt_cancel_by (0017).
--
-- -----------------------------------------------------------------------------
-- WHY id_visit IS STORED RAW AS WELL AS DERIVED
-- -----------------------------------------------------------------------------
-- The booleans lose information: PENDING and BOOK both mean "not attended yet"
-- but for different reasons, and REMOVE means something else again. Keeping WL's
-- own code means a later question - "how many are waiting on staff review" -
-- is a WHERE clause rather than another migration. Text, like every other WL
-- key: an integer would invite arithmetic on a code.
--
-- Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. WL's own status
-- -----------------------------------------------------------------------------
alter table public.attendance
  add column if not exists id_visit text;

comment on column public.attendance.id_visit is
  'WellnessLiving''s visit status (WlVisitSid): 1 BOOK, 2 WAIT, 3 ATTEND, '
  '4 PENALTY (cancelled too late), 5 TRUANCY (missed, no cancellation), '
  '6 CANCEL (cancelled in time), 7 PENDING (staff must decide), 8 REMOVE. THE '
  'authoritative outcome - the booleans beside it are derived from this. Null '
  'means the element call has not filled it yet, which WL documents as possible.';

create index if not exists attendance_id_visit_idx
  on public.attendance (k_business, id_visit);


-- -----------------------------------------------------------------------------
-- 2. is_attended must be able to say "unknown"
-- -----------------------------------------------------------------------------
-- `not null default false` asserted that every visit was not attended until
-- proven otherwise. For a session that has not happened, or one WL has marked
-- PENDING for staff to decide, that is a claim we cannot make - and it is the
-- claim a royalty is calculated against.
alter table public.attendance
  alter column is_attended drop default;

alter table public.attendance
  alter column is_attended drop not null;

comment on column public.attendance.is_attended is
  'True only when WL says ATTEND (id_visit 3). NULL means not yet known - the '
  'session is still upcoming, or WL has it PENDING for staff to decide, or the '
  'detail has not been read. Deliberately nullable: it used to be `not null '
  'default false`, which made "no idea" and "did not turn up" the same value in '
  'the column royalty is paid from.';

-- The 4 rows that read true came from is_checkin, which means something else, and
-- is_checkin is false on every session anyway - so there is nothing to preserve.
-- Reset to unknown rather than to false: false would be a fresh wrong claim.
update public.attendance
   set is_attended = null
 where id_visit is null;


-- -----------------------------------------------------------------------------
-- 3. Derive the booleans from the status, in one place
-- -----------------------------------------------------------------------------
-- The writer sets these too, so a re-parse and a fresh sync agree. Run here so
-- rows already carrying an id_visit are corrected without waiting for a re-read.
--
-- PENALTY (4) sets BOTH is_cancelled_client and is_late_cancel: it is a
-- cancellation, and is_late_cancel's own reason for existing (0004) is that a
-- late one is "usually still billable", which is a different question from
-- whether it was cancelled.
update public.attendance
   set is_attended          = (id_visit = '3'),
       is_no_show           = (id_visit = '5'),
       is_cancelled_client  = (id_visit in ('4', '6')),
       is_late_cancel       = (id_visit = '4')
 where id_visit is not null
   and id_visit in ('3', '4', '5', '6');

-- Statuses that carry no outcome yet. is_attended stays NULL; the rest are
-- false because "not cancelled" and "not a no-show" are true statements about a
-- booking that is merely open.
update public.attendance
   set is_attended         = null,
       is_no_show          = false,
       is_cancelled_client = false,
       is_late_cancel      = false
 where id_visit in ('1', '2', '7', '8');


-- -----------------------------------------------------------------------------
-- 4. Correct what is_checkin is documented to mean
-- -----------------------------------------------------------------------------
comment on column public.session.is_checkin is
  'Whether WL will currently ACCEPT a check-in for this session - the API says '
  '"ready to be checked in" / "can''t be checked in". NOT whether anybody '
  'attended: it was read that way once and produced an empty royalty signal '
  '(true on 0 of 4,423 sessions). Attendance is attendance.id_visit = 3.';


-- -----------------------------------------------------------------------------
-- 5. session_outcome, reading the status WL actually sends
-- -----------------------------------------------------------------------------
-- Recreated in full; Postgres cannot edit a branch of an existing view.
--
-- ORDER MATTERS. A studio cancellation outranks everything because it is the
-- studio's own act. Then WL's own verdict, because it is the system of record on
-- what happened. Request state and wait-listing only describe a booking that has
-- no verdict yet.
drop view if exists public.session_outcome;

create view public.session_outcome
  with (security_invoker = on) as
  select
    a.k_period,
    a.dt_start_utc,
    a.uid,
    a.k_business,
    a.k_visit,
    s.session_kind,
    s.text_title,
    s.dtl_start_local,
    s.text_timezone,

    a.id_visit,
    s.is_cancelled_studio,
    a.is_cancelled_client,
    a.is_attended,
    a.is_no_show,
    -- Exposed for the first time. It was populated by nothing and read by
    -- nobody, and it is the field the late-cancellation billing question is
    -- answered from.
    a.is_late_cancel,
    a.is_waitlisted,
    a.is_unpaid,
    s.is_checkin,
    s.dt_cancel_by,
    s.is_request,
    s.is_confirmed,
    s.is_denied,
    s.is_reviewed,

    case
      when s.is_cancelled_studio then 'studio_cancelled'
      when a.id_visit = '3'      then 'attended'
      when a.id_visit = '4'      then 'client_cancelled_late'
      when a.id_visit = '5'      then 'missed'
      when a.id_visit = '6'      then 'client_cancelled'
      when a.id_visit = '8'      then 'removed'
      when a.id_visit = '7'      then 'awaiting_staff'
      when s.is_denied           then 'denied'
      when s.is_request          then 'requested'
      when a.is_waitlisted       then 'waitlisted'
      when a.id_visit in ('1', '2') and s.dt_start_utc > now() then 'upcoming'
      when s.dt_start_utc > now() then 'upcoming'
      else 'unknown'
    end as outcome,

    -- May this earn a royalty?
    --
    -- Now requires WL to have said ATTEND. Before this migration it required
    -- only that the session was reviewed, past, and not cancelled or refused -
    -- which would have paid on a session nobody attended, and on one WL had
    -- marked PENDING. Nothing is lost by tightening it: 0 rows were countable.
    --
    -- A LATE CANCELLATION IS DELIBERATELY NOT COUNTABLE HERE, and that is an
    -- open policy question rather than a settled answer. is_late_cancel's
    -- comment (0004) says such a cancellation is "usually still billable", but
    -- billable to the CLIENT is not the same as royalty-bearing to the TEACHER,
    -- and nobody has decided which. It is exposed above so the decision can be
    -- made in a WHERE clause and seen, instead of being assumed here.
    (
      -- coalesce, not a bare comparison. With id_visit NULL the comparison is
      -- NULL and the whole AND collapses to NULL, so is_countable came back
      -- null for "we have not read the detail" but false for an unrecognised
      -- code - the same situation reported two different ways in the column a
      -- payment is decided from. The payment flag is always definite; the
      -- uncertainty lives in is_attended and outcome, which can say so.
      coalesce(a.id_visit = '3', false)
      and s.is_reviewed
      and not s.is_request
      and not s.is_denied
      and not s.is_cancelled_studio
      and not a.is_waitlisted
      and s.dt_start_utc <= now()
    ) as is_countable

  from public.attendance a
  join public.session s
    on s.k_period = a.k_period
   and s.dt_start_utc = a.dt_start_utc;

comment on view public.session_outcome is
  'outcome says what happened, from WL''s own visit status; is_countable says '
  'whether it may be paid on. Different questions, answered separately. '
  'is_countable now requires id_visit = 3 (ATTEND) - it previously required only '
  'that a session was reviewed and past, which would pay on a session nobody '
  'attended. A late cancellation is NOT counted; whether it should be is an open '
  'decision, which is why is_late_cancel is exposed rather than folded in.';


-- -----------------------------------------------------------------------------
-- 6. What is waiting on a human
-- -----------------------------------------------------------------------------
-- PENDING is WL asking the studio to say what happened. Those sessions can never
-- become countable on their own, so a growing count is a backlog nobody would
-- otherwise see.
create or replace view public.visit_awaiting_staff as
  select a.k_business,
         a.uid,
         a.k_period,
         a.dt_start_utc,
         a.k_visit,
         s.text_title,
         s.dtl_start_local
  from public.attendance a
  join public.session s
    on s.k_period = a.k_period
   and s.dt_start_utc = a.dt_start_utc
  where a.id_visit = '7'
    and s.dt_start_utc <= now();

comment on view public.visit_awaiting_staff is
  'Past visits WL has left as PENDING - it knows the client was registered but '
  'not whether they attended, missed, or cancelled late, and says the real type '
  '"must be set manually by staff". These can never earn a royalty until '
  'somebody in the studio resolves them.';

alter view public.visit_awaiting_staff set (security_invoker = on);
