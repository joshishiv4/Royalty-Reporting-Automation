-- =============================================================================
-- Portal projections - the final verification. READ-ONLY, changes nothing.
--
-- Covers migrations 0039 through 0045: identity/student/teacher, cohort/
-- class_session, attendance_record, and every link between them.
--
-- Run in the SQL editor. EVERY ROW MUST READ PASS. Rows marked INFO are numbers
-- worth looking at rather than conditions to satisfy - a value there is not a
-- failure, but a value that surprises you is worth chasing.
--
-- WHY THIS IS NOT THE SAME AS 0045
--   0045 REPAIRS. This one only looks, and it looks at things a repair cannot
--   fix - a column that came back not-null, a WellnessLiving key that leaked into
--   an owned table, a trigger that is simply gone. A reconcile that runs against
--   a broken schema reports "0 repaired" and is believed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Every portal table exists
-- -----------------------------------------------------------------------------
select
  case when count(*) = 10 then 'PASS' else 'FAIL' end as result,
  '1  all ten portal tables exist'                    as label,
  count(*)                                            as found,
  10                                                  as expected
from pg_tables
where schemaname = 'public'
  and tablename in (
    'identity', 'student', 'teacher',
    'cohort', 'class_session', 'class_session_teacher',
    'attendance_record',
    'cohort_link', 'session_link', 'attendance_link'
  );

-- -----------------------------------------------------------------------------
-- 2. THE STANDING RULE - no WellnessLiving field on an owned table
--
-- The portal reads these. A uid, k_staff or k_period appearing on one means the
-- mapping has leaked out of the link tables and the portal has started to know
-- that WellnessLiving exists.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '2  no WellnessLiving column on an owned table'    as label,
  count(*)                                           as leaked,
  coalesce(string_agg(table_name || '.' || column_name, ', '), '') as columns
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'student', 'teacher', 'cohort', 'class_session',
    'class_session_teacher', 'attendance_record'
  )
  and (column_name like 'k\_%' or column_name in ('uid', 'text_login_type'));

-- -----------------------------------------------------------------------------
-- 3. Every projection trigger is present
--
-- This is the failure the whole design is most exposed to: a trigger that stops
-- existing raises nothing. Rows simply stop appearing.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 14 then 'PASS' else 'FAIL' end as result,
  '3  all fourteen projection triggers exist'         as label,
  count(*)                                            as found,
  14                                                  as expected
from pg_trigger
where not tgisinternal
  and tgname in (
    'person_identity_insert', 'person_identity_login_type',
    'login_type_identity_rule_insert', 'login_type_identity_rule_update',
    'session_class_session_insert', 'session_class_session_update',
    'session_staff_class_session_insert', 'session_staff_class_session_update',
    'identity_class_session_teacher_insert', 'identity_class_session_teacher_update',
    'attendance_record_insert', 'attendance_record_update',
    'identity_attendance_record_insert', 'identity_attendance_record_update'
  );

-- Which one is missing, when the count above is short.
select
  'INFO'                          as result,
  '3b triggers NOT found'         as label,
  coalesce(string_agg(t.want, ', '), 'none') as missing
from (values
  ('person_identity_insert'), ('person_identity_login_type'),
  ('login_type_identity_rule_insert'), ('login_type_identity_rule_update'),
  ('session_class_session_insert'), ('session_class_session_update'),
  ('session_staff_class_session_insert'), ('session_staff_class_session_update'),
  ('identity_class_session_teacher_insert'), ('identity_class_session_teacher_update'),
  ('attendance_record_insert'), ('attendance_record_update'),
  ('identity_attendance_record_insert'), ('identity_attendance_record_update')
) as t(want)
where not exists (
  select 1 from pg_trigger g where not g.tgisinternal and g.tgname = t.want
);

-- -----------------------------------------------------------------------------
-- 4. is_attended can still say "not yet known"
--
-- 0029 made this nullable on `attendance` because `not null default false` makes
-- "we have no idea" and "they did not turn up" the same value - in the column a
-- royalty is calculated from. 0043's first draft reintroduced it on
-- attendance_record. If this ever reads FAIL again, somebody has done it a third
-- time.
-- -----------------------------------------------------------------------------
select
  case when bool_and(not is_nullable = 'NO') then 'PASS' else 'FAIL' end as result,
  '4  attendance_record.is_attended is nullable'                         as label,
  min(is_nullable)                                                       as is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'attendance_record'
  and column_name = 'is_attended';

-- -----------------------------------------------------------------------------
-- 5. Completeness - nothing in the mirror is missing from the projection
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '5a every person has an identity'                  as label,
  count(*)                                           as missing
from public.person p
where not exists (select 1 from public.identity i where i.uid = p.uid);

select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '5b every session has a class_session'             as label,
  count(*)                                           as missing
from public.session s
where not exists (
  select 1 from public.session_link sl
   where sl.k_period = s.k_period and sl.dt_start_utc = s.dt_start_utc
     and sl.class_session_id is not null
);

-- Only attendance whose BOTH halves resolve is expected. One whose person is a
-- teacher, or has no role yet, is absent by design - see 5d.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end   as result,
  '5c every resolvable attendance is projected'        as label,
  count(*)                                             as missing
from public.attendance a
join public.session_link sl
  on sl.k_period = a.k_period and sl.dt_start_utc = a.dt_start_utc
 and sl.class_session_id is not null
join public.identity i on i.uid = a.uid and i.student_id is not null
where not exists (
  select 1 from public.attendance_record ar
   where ar.class_session_id = sl.class_session_id
     and ar.student_id = i.student_id
);

select
  'INFO'                                                  as result,
  '5d attendance skipped because the person is not a student' as label,
  count(*)                                                as skipped
from public.attendance a
join public.identity i on i.uid = a.uid
where i.student_id is null;

-- -----------------------------------------------------------------------------
-- 6. Correctness - the role rule, and no double-counting
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '6a nobody holds both roles'                       as label,
  count(*)                                           as both
from public.identity
where student_id is not null and teacher_id is not null;

select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '6b every role matches login_type.is_teacher_type' as label,
  count(*)                                           as disagreeing
from public.person p
join public.identity i on i.uid = p.uid
left join public.login_type lt
  on lt.k_login_type = p.k_login_type and lt.k_business = p.k_business
where p.k_login_type is not null
  and (
    (coalesce(lt.is_teacher_type, false) and i.teacher_id is null)
    or (not coalesce(lt.is_teacher_type, false) and i.student_id is null)
  );

-- One role row belongs to one human. Without this the double-count the hub
-- exists to prevent walks back in through the role instead of the person.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '6c no student row shared by two identities'       as label,
  count(*)                                           as shared
from (
  select student_id from public.identity
   where student_id is not null
   group by student_id having count(*) > 1
) x;

-- -----------------------------------------------------------------------------
-- 7. The links map one to one
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '7a no class_session claimed by two session_links' as label,
  count(*)                                           as shared
from (
  select class_session_id from public.session_link
   where class_session_id is not null
   group by class_session_id having count(*) > 1
) x;

select
  case when count(*) = 0 then 'PASS' else 'FAIL' end   as result,
  '7b no attendance_record claimed by two links'       as label,
  count(*)                                             as shared
from (
  select attendance_record_id from public.attendance_link
   where attendance_record_id is not null
   group by attendance_record_id having count(*) > 1
) x;

-- -----------------------------------------------------------------------------
-- 8. PROVENANCE - presence of a link is the answer, so count both sides
--
-- A row with no link was created in the portal. Today nothing creates one, so a
-- non-zero here means either the portal has started writing, or a projection ran
-- half way. Both are worth knowing; neither is readable from a `source` column,
-- because there deliberately is not one.
-- -----------------------------------------------------------------------------
select
  'INFO'                                        as result,
  '8a class_sessions with no link (portal-created)' as label,
  count(*)                                      as unlinked
from public.class_session cs
where not exists (
  select 1 from public.session_link sl where sl.class_session_id = cs.id
);

select
  'INFO'                                            as result,
  '8b attendance_records with no link (portal-recorded)' as label,
  count(*)                                          as unlinked
from public.attendance_record ar
where not exists (
  select 1 from public.attendance_link al where al.attendance_record_id = ar.id
);

-- -----------------------------------------------------------------------------
-- 9. The shape of what landed. All INFO - read them, do not assert on them.
-- -----------------------------------------------------------------------------
select 'INFO' as result, '9  row counts' as label,
  (select count(*) from public.person)            as person,
  (select count(*) from public.identity)          as identity,
  (select count(*) from public.student)           as student,
  (select count(*) from public.teacher)           as teacher,
  (select count(*) from public.session)           as wl_session,
  (select count(*) from public.class_session)     as class_session,
  (select count(*) from public.cohort)            as cohort,
  (select count(*) from public.cohort where not is_resolved) as cohort_stubbed,
  (select count(*) from public.attendance)        as wl_attendance,
  (select count(*) from public.attendance_record) as attendance_record;

-- The outcome spread. `not_yet_known` SHOULD be large: 0029 measured that the
-- live outcome is mostly unsettled. If it is 0 and everything sits in
-- did_not_attend, the nullable column has been coalesced away again.
select 'INFO' as result, '10 attendance outcomes' as label,
  count(*)                                        as total,
  count(*) filter (where is_attended is null)     as not_yet_known,
  count(*) filter (where is_attended)             as attended,
  count(*) filter (where is_attended = false)     as did_not_attend
from public.attendance_record;

-- Identities still waiting for a role. Not an error - it is the deliberate "not
-- yet known" state for a stub person. A number that climbs over time means
-- profile enrichment has stopped.
select 'INFO' as result, '11 identities with no role yet' as label,
  count(*) as role_unknown
from public.identity
where student_id is null and teacher_id is null;
