-- =============================================================================
-- identity / student / teacher - the triggers, proved rather than asserted
--
-- Tasks 1.2, 1.3 and 1.4. Migrations 0039 and 0040.
--
-- WHY THIS FILE EXISTS
--   The hub is entirely trigger-maintained, which is the right design - it cannot
--   be forgotten by a future writer - but it fails in one bad way: if a trigger
--   stops firing, nothing errors. Rows simply stop appearing and everything looks
--   fine. Only a check that DOES the thing and looks at the result can tell.
--
--   So sections 3 to 7 below are not catalogue inspections. They insert, change
--   and delete real rows, read what the triggers did, and roll the whole lot back.
--
-- CHANGES NOTHING. Every section that writes runs inside BEGIN ... ROLLBACK.
-- Read the rollbacks before trusting that sentence; do not remove one.
--
-- Run in the SQL editor. Every row must read PASS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Task 1.2 - every existing person has exactly one identity
--
-- The backfill in 0040 is the only thing that has ever populated these rows for
-- people who predate it. A person with no identity is a hole the portal will read
-- as "this student does not exist".
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '1.2  every person has an identity'                as label,
  count(*)                                           as people_without_identity
from public.person p
where not exists (select 1 from app.identity i where i.uid = p.uid);

-- The other direction. An identity claiming a uid no person has means the link
-- outlived what it pointed at, which ON DELETE SET NULL is supposed to prevent.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '1.2  no identity points at a missing person'      as label,
  count(*)                                           as dangling
from app.identity i
where i.uid is not null
  and not exists (select 1 from public.person p where p.uid = i.uid);

-- -----------------------------------------------------------------------------
-- 2. Task 1.2 - the staff come through as teachers, and nobody holds two roles
--
-- The rule is login_type.is_teacher_type. This checks the RESULT of that rule
-- against the rule itself, which is the only way to catch a backfill that ran
-- against a stale login_type table.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end   as result,
  '1.2  everyone on a teacher login type is a teacher' as label,
  count(*)                                             as misfiled
from public.person p
join public.login_type lt
  on lt.k_login_type = p.k_login_type
 and lt.k_business   = p.k_business
join app.identity i on i.uid = p.uid
where lt.is_teacher_type
  and i.teacher_id is null;

select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '1.2  nobody holds both roles'                     as label,
  count(*)                                           as both_roles
from app.identity
where student_id is not null and teacher_id is not null;

-- A stub person - one written only to hold a foreign key, with no login type -
-- must have an identity and NO role. This is the deliberate "not yet known"
-- state from 0040. It is reported as a COUNT and is not a failure; a number
-- climbing over time means enrichment has stopped, which is worth knowing.
select
  'INFO'                                    as result,
  '1.2  identities whose role is not yet known' as label,
  count(*)                                  as role_unknown
from app.identity i
join public.person p on p.uid = i.uid
where p.k_login_type is null
  and i.student_id is null
  and i.teacher_id is null;

-- -----------------------------------------------------------------------------
-- 3. Task 1.3 - inserting a person creates the identity, with no application code
-- -----------------------------------------------------------------------------
begin;

insert into public.person (uid, k_business, k_login_type)
select '__check_person_1', p.k_business, null
  from (select distinct k_business from public.person limit 1) p;

select
  case when count(*) = 1 then 'PASS' else 'FAIL' end as result,
  '1.3  inserting a person creates its identity'     as label,
  count(*)                                           as identities
from app.identity where uid = '__check_person_1';

-- A stub gets an identity and no role. If this returns a role, the assumption in
-- 0040 was silently reversed and a future teacher is being shown as a student.
select
  case when count(*) = 1 then 'PASS' else 'FAIL' end as result,
  '1.3  a stub person gets no role yet'              as label,
  count(*)                                           as roleless
from app.identity
where uid = '__check_person_1'
  and student_id is null
  and teacher_id is null;

rollback;

-- -----------------------------------------------------------------------------
-- 4. Task 1.3 - a login type arriving later fills the role
--
-- This is the path stub people actually take: recipients.ts writes {uid,
-- k_business}, and profile enrichment supplies k_login_type hours or days later.
-- -----------------------------------------------------------------------------
begin;

insert into public.person (uid, k_business, k_login_type)
select '__check_person_2', p.k_business, null
  from (select distinct k_business from public.person limit 1) p;

update public.person
   set k_login_type = (select k_login_type from public.login_type
                        where is_teacher_type limit 1)
 where uid = '__check_person_2';

select
  case when count(*) = 1 then 'PASS' else 'FAIL' end       as result,
  '1.3  a late login type promotes a stub to its role'     as label,
  count(*)                                                 as promoted
from app.identity
where uid = '__check_person_2' and teacher_id is not null;

rollback;

-- -----------------------------------------------------------------------------
-- 5. Task 1.3 - an unchanged nightly pass does no pointless work
--
-- The sync upserts k_login_type on every person every night. Without the
-- IS DISTINCT FROM guard on trigger 2, that fires on every row and the role
-- update moves updated_at on all of them - after which "what changed recently"
-- answers "everything, every night" and is useless.
--
-- Rewriting a person with the SAME login type must leave the role row untouched.
-- -----------------------------------------------------------------------------
begin;

create temporary table __check_before on commit drop as
select i.student_id, i.teacher_id,
       coalesce(s.updated_at, t.updated_at) as role_updated_at
  from app.identity i
  left join app.student s on s.id = i.student_id
  left join app.teacher t on t.id = i.teacher_id
 where i.uid = (select uid from app.identity
                 where student_id is not null or teacher_id is not null limit 1);

update public.person p
   set k_login_type = p.k_login_type
 where p.uid = (select i.uid from app.identity i
                 where i.student_id is not null or i.teacher_id is not null
                 limit 1);

select
  case when count(*) = 0 then 'PASS' else 'FAIL' end   as result,
  '1.3  an unchanged pass does not touch the role row' as label,
  count(*)                                             as needlessly_touched
from __check_before b
  join app.identity i
    on i.student_id is not distinct from b.student_id
   and i.teacher_id is not distinct from b.teacher_id
  left join app.student s on s.id = i.student_id
  left join app.teacher t on t.id = i.teacher_id
 where coalesce(s.updated_at, t.updated_at) is distinct from b.role_updated_at;

rollback;

-- -----------------------------------------------------------------------------
-- 6. Task 1.4 - changing the teacher rule re-sorts everyone, touching no person
--
-- 0014 made the teacher rule data on purpose: "changing who counts as a teacher
-- is an UPDATE here, not a deploy." The failure this catches is a design that
-- only watches `person` - flip the flag and every role is silently wrong, with
-- not one person row modified to hint at it.
-- -----------------------------------------------------------------------------
begin;

create temporary table __check_persons_before on commit drop as
select uid, updated_at from public.person;

-- Promote some other login type to teacher and confirm its people move.
update public.login_type
   set is_teacher_type = true
 where k_login_type = (
   select p.k_login_type
     from public.person p
     join public.login_type lt
       on lt.k_login_type = p.k_login_type and lt.k_business = p.k_business
    where not lt.is_teacher_type
    group by p.k_login_type
    having count(*) > 0
    limit 1
 );

select
  case when count(*) = 0 then 'PASS' else 'FAIL' end  as result,
  '1.4  flipping the rule re-sorts everyone on it'    as label,
  count(*)                                            as left_behind
from public.person p
join public.login_type lt
  on lt.k_login_type = p.k_login_type and lt.k_business = p.k_business
join app.identity i on i.uid = p.uid
where lt.is_teacher_type
  and i.teacher_id is null;

-- And it did so without writing to person. If this fails, something is updating
-- person to make the roles move, which is the two-writers-one-fact failure.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  '1.4  it did that with zero person rows updated'   as label,
  count(*)                                           as persons_touched
from public.person p
join __check_persons_before b on b.uid = p.uid
where p.updated_at is distinct from b.updated_at;

rollback;

-- -----------------------------------------------------------------------------
-- 7. Deleting a person nulls the link and keeps the identity
--
-- ON DELETE SET NULL, not CASCADE. The identity carries data that has nothing to
-- do with WellnessLiving; losing the mirror row must never destroy it. After the
-- null the identity is indistinguishable from a portal-native one.
--
-- The uid is GONE, not parked. An earlier draft kept it in uid_detached so a
-- later re-link was an exact match; that column was dropped on 17 Sep 2026
-- because a foreign key can null a value but cannot copy it first, so it would
-- never have filled. See 0039 for the full reasoning. This section therefore
-- proves survival, which is the guarantee that remains, and must identify the
-- row by the id captured BEFORE the delete - after it there is nothing linking
-- the identity back to the uid, which is precisely the cost that was accepted.
-- -----------------------------------------------------------------------------
begin;

insert into public.person (uid, k_business, k_login_type)
select '__check_person_3', p.k_business, null
  from (select distinct k_business from public.person limit 1) p;

create temporary table __check_identity_before on commit drop as
select id from app.identity where uid = '__check_person_3';

delete from public.person where uid = '__check_person_3';

select
  case when count(*) = 1 then 'PASS' else 'FAIL' end   as result,
  '7  deleting a person keeps the identity, uid nulled' as label,
  count(*)                                             as surviving
from app.identity i
join __check_identity_before b on b.id = i.id
where i.uid is null;

rollback;

-- -----------------------------------------------------------------------------
-- 8. The standing rule - no WellnessLiving field on an owned table
--
-- student and teacher are what the portal reads. A uid or k_staff appearing on
-- either means the mapping has leaked out of identity, and the portal has started
-- to know that WellnessLiving exists.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end   as result,
  '8  no WellnessLiving column on student or teacher'  as label,
  count(*)                                             as leaked,
  coalesce(string_agg(table_name || '.' || column_name, ', '), '') as columns
from information_schema.columns
where table_schema = 'app'
  and table_name in ('student', 'teacher')
  and (column_name like 'k\_%' or column_name in ('uid', 'text_login_type'));
