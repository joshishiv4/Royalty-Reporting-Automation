-- -----------------------------------------------------------------------------
-- 0061  app.course_catalogue - the recommendation quiz's course menu
-- -----------------------------------------------------------------------------
-- The course-recommendation quiz (task 034) needs a list of real courses and
-- the teachers who teach them to offer to the model. Two sources carry that,
-- and neither is enough alone:
--
--   public.service      - 123 real sold courses (DJ For Everyone, Music
--                         Production, ...), but the WL staff<->service link
--                         table (staff_service) is EMPTY on this environment,
--                         so a service has no teacher of its own.
--   app.cohort          - only a handful of courses, but DOES carry teachers
--                         (via class_session -> class_session_teacher).
--
-- A service's teachers are instead recoverable through its sessions:
--   service.k_service -> public.session.k_service
--                     -> public.session_staff.k_period
--                     -> public.person.k_staff  (the teacher's name)
-- That join is over ~46k sessions, far too heavy to run per quiz submission
-- from the portal, so it lives here in SQL and the portal reads one view.
--
-- WHY GROUP BY BASE TITLE
--   A single course appears many times in service, once per duration/location
--   ("DJ For Everyone | 60 Minutes", "| 45 Minutes", "| In-Home | 60 Minutes").
--   The quiz should offer one "DJ For Everyone", not a dozen near-duplicates, so
--   the base title is the part before the first "|". The same split applies to
--   cohort titles ("DJ Group Class | 90 Minutes" -> "DJ Group Class").
--
-- WHY A LEFT JOIN TO TEACHERS
--   A base course with no resolvable teacher must still be offerable, so the
--   base titles drive the result and teachers are joined on; such a course gets
--   a single row with teacher_name null.
--
-- Everything-with-a-title: no filtering on is_package / is_bookable / is_resolved
-- was requested, so any service (or cohort) with a non-empty title is included.
--
-- create-or-replace: idempotent, safe to re-run. New app-schema views are
-- granted to service_role by the default privileges set in 0047.
-- -----------------------------------------------------------------------------

create or replace view app.course_catalogue as
with base_titles as (
  select distinct btrim(split_part(title, '|', 1)) as base_title
  from public.service
  where coalesce(btrim(title), '') <> ''
  union
  select distinct btrim(split_part(title, '|', 1))
  from app.cohort
  where coalesce(btrim(title), '') <> ''
),
service_teachers as (
  select distinct
    btrim(split_part(s.title, '|', 1))               as base_title,
    btrim(concat_ws(' ', p.first_name, p.last_name)) as teacher_name
  from public.service s
  join public.session ses      on ses.k_service = s.k_service
  join public.session_staff ss on ss.k_period   = ses.k_period
  join public.person p         on p.k_staff      = ss.k_staff
  where coalesce(btrim(s.title), '') <> ''
),
cohort_teachers as (
  select distinct
    btrim(split_part(c.title, '|', 1))               as base_title,
    btrim(concat_ws(' ', t.first_name, t.last_name)) as teacher_name
  from app.cohort c
  join app.class_session cs          on cs.cohort_id       = c.id
  join app.class_session_teacher cst on cst.class_session_id = cs.id
  join app.teacher t                 on t.id               = cst.teacher_id
  where coalesce(btrim(c.title), '') <> ''
),
all_teachers as (
  select base_title, teacher_name
  from (
    select base_title, teacher_name from service_teachers
    union
    select base_title, teacher_name from cohort_teachers
  ) u
  where coalesce(btrim(teacher_name), '') <> ''
)
select b.base_title,
       at.teacher_name
from base_titles b
left join all_teachers at on at.base_title = b.base_title;

-- Run as the querying role (service_role, which bypasses RLS on the public
-- source tables), matching the other cross-table views in this project.
alter view app.course_catalogue set (security_invoker = on);

comment on view app.course_catalogue is
  'One row per (base course, teacher) for the recommendation quiz. Base course '
  'is the title before the first "|", unioned from public.service (teachers via '
  'session -> session_staff -> person) and app.cohort (teachers via '
  'class_session_teacher). A course with no resolvable teacher appears once with '
  'teacher_name null. See migration 0061 for why.';
