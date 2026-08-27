-- =============================================================================
-- 0030  attendance.dt_checkin_utc - when the client actually checked in
--
-- Adds the one attendance fact WellnessLiving publishes and this project throws
-- away, and a view for the visits that happened but were never resolved.
--
-- -----------------------------------------------------------------------------
-- WHY THIS COLUMN
-- -----------------------------------------------------------------------------
-- /v1/login/attendance/list returns, per client record:
--
--   dt_register - "The date the client checked in for the visit, in UTC."
--
-- That is a real check-in MOMENT, and it is the field that was being looked for
-- when `is_checkin` was misread as attendance (0029). is_checkin is a capability
-- - "ready to be checked in" - and was true on 0 of 4,423 sessions. dt_register
-- is the event. Measured on live dev 27 Aug 2026: present on 55 of 55 sampled
-- client records, alongside is_penalty, is_pending and id_visit - NONE of which
-- appear in WellnessLiving's published OpenAPI spec. The spec is dated
-- 2024-12-24 and under-reports; it is a floor, not a contract.
--
-- WHY IT IS WORTH STORING WHEN id_visit ALREADY SAYS "ATTEND". Two reasons, both
-- about questions id_visit cannot answer:
--
--   1. Q9 to the client - "is check-in used consistently for private lessons" -
--      becomes MEASURABLE instead of a question. A studio that checks people in
--      produces timestamps; one that does not produces nulls. Counting nulls per
--      service type answers it without asking anybody.
--   2. A royalty dispute is about a moment. "WL says they attended" is weaker
--      evidence than "WL recorded a check-in at 18:57 on 19 Aug".
--
-- It is NOT a second opinion on attendance. id_visit remains the authority
-- (0029); this is evidence beside the verdict, which is why nothing derives
-- from it and no view gates on it.
--
-- -----------------------------------------------------------------------------
-- WHY THE VIEW
-- -----------------------------------------------------------------------------
-- Measured after the id_visit backfill, 27 Aug 2026:
--
--   attendance rows                     4,431
--   id_visit null                           0   (was 4,431)
--   3 ATTEND                                3
--   7 PENDING                               3
--   1 BOOK                              4,425
--   session_outcome 'unknown'              29
--
-- Those 29 are past sessions WellnessLiving still reports as BOOK - the session
-- happened and no outcome was ever recorded. `visit_awaiting_staff` (0029) does
-- not catch them: WL has not even marked them PENDING, so nothing flags them and
-- they simply read as 'unknown' in a column nobody watches.
--
-- For royalty that is exactly the ambiguous set: not attended, not cancelled, not
-- upcoming. A count that grows is a studio not closing out its sessions.
--
-- Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The check-in moment
-- -----------------------------------------------------------------------------
alter table public.attendance
  add column if not exists dt_checkin_utc timestamptz;

comment on column public.attendance.dt_checkin_utc is
  'When WellnessLiving recorded the client checking in (attendance/list '
  '`dt_register`, "the date the client checked in for the visit, in UTC"). '
  'EVIDENCE, NOT VERDICT: attendance is id_visit = 3, and nothing derives from '
  'this column. Null means no check-in was recorded, which is NOT the same as '
  'not attending - a studio that does not use check-in produces nulls on '
  'sessions that happened. Counting nulls per service type is how Q9 (is '
  'check-in used consistently for private lessons) gets answered without asking. '
  'UTC only, like every other dt_ column here.';

-- The Q9 question is "how many visits have no check-in", so the useful index is
-- on the rows that DO carry one.
create index if not exists attendance_checkin_idx
  on public.attendance (k_business, dt_checkin_utc)
  where dt_checkin_utc is not null;


-- -----------------------------------------------------------------------------
-- 2. Sessions that happened, with no outcome from WellnessLiving
-- -----------------------------------------------------------------------------
-- Deliberately separate from visit_awaiting_staff (0029). That view lists visits
-- WL has marked PENDING - it knows a decision is owed. This one lists visits WL
-- still calls BOOK or WAIT after the session ran, where WL is not asking anybody
-- for anything and the row would otherwise read 'unknown' and be ignored.
create or replace view public.visit_unresolved_past as
  select a.k_business,
         a.uid,
         a.k_period,
         a.dt_start_utc,
         a.k_visit,
         a.id_visit,
         a.dt_checkin_utc,
         s.session_kind,
         s.text_title,
         s.dtl_start_local,
         s.is_reviewed,
         -- How long it has been unresolved, so a reader can tell a session that
         -- ended an hour ago from one abandoned in July.
         (now() - s.dt_start_utc) as unresolved_for
  from public.attendance a
  join public.session s
    on s.k_period = a.k_period
   and s.dt_start_utc = a.dt_start_utc
  where s.dt_start_utc <= now()
    and coalesce(a.id_visit, '1') in ('1', '2')
    and not s.is_cancelled_studio;

comment on view public.visit_unresolved_past is
  'Visits whose session has already run while WellnessLiving still reports them '
  'as BOOK or WAIT - it happened and no outcome was ever recorded. These read as '
  'outcome ''unknown'' in session_outcome and can never be countable. Distinct '
  'from visit_awaiting_staff, which is WL explicitly asking staff to decide; '
  'here WL is asking nobody. 29 rows on live dev at 27 Aug 2026, out of 34 '
  'sessions that had started.';

alter view public.visit_unresolved_past set (security_invoker = on);
