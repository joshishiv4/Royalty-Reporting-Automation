-- =============================================================================
-- 0063  teacher_note: a private note may name a student
--
-- WHAT CHANGES
--   A private note used to carry no student - `0056` made that a rule
--   (`private => student_id is null`). A teacher can now tag a private note with a
--   student, so they remember who it is about. The note STAYS private: only its
--   author reads it. The tag is a label for the teacher, not a way to share.
--   The student is optional; an untagged private note is unchanged. A public note
--   still requires exactly one student.
--
-- THREE THINGS MOVE, AND ONE MUST NOT
--
--   1. teacher_note_kind_check is relaxed to `public => student_id is not null`.
--      Private is now unconstrained, which is the whole point of the change.
--
--   2. The roster rule follows the STUDENT, not the kind. `0056` checked
--      `app.teaches_student()` for public notes only, because a private note had no
--      student to check. Now ANY note that names a student must name one the teacher
--      taught: the INSERT and UPDATE `with check` become
--      `student_id is null or app.teaches_student(student_id)`. Without this a
--      teacher could tag a private note with a student they never taught, and the
--      portal's picker (the roster) would be the only thing stopping it - a client
--      check, not the database's.
--
--      The `is null` here is on a plain column. The rule in 0055 against `is null`
--      is about current_teacher_id() / current_student_id(), where NULL must read
--      as "no rows"; a note with no student is a legitimate row, not a stranger.
--
--   3. teacher_note_student_select is NOT touched - and that is the point worth
--      reading twice. It is `visibility = 'public' and student_id =
--      current_student_id() and deleted_at is null`. Until now the first condition
--      was backed up by the kind check: a private note had no student, so it could
--      not match the second condition anyway. That backstop is gone. From here the
--      `visibility = 'public'` guard is the ONLY thing standing between a tagged
--      private note and the student it is about. The trailing checks assert it is
--      still there, and `teacher_note_isolation.sql` section I tries it.
--
-- NO EXISTING ROW CHANGES. Every current private note has no student, which the
-- relaxed constraint still allows. This migration adds nothing a row must satisfy
-- that it did not already.
--
-- Depends on 0056 and 0058. Safe to re-run.
--
-- ORDER MATTERS IF 0056 IS EVER RE-RUN. 0056 drops and recreates the insert and
-- update policies with its original (public-only) roster rule, which would quietly
-- undo section 2 below, with nothing to say so. After re-running 0056, re-run this
-- file too. (The trailing checks only run when this file does, so they cannot
-- catch a forgotten re-run.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The kind check: only a public note needs a student
-- -----------------------------------------------------------------------------
-- `teacher_note_visibility_check` still limits visibility to private / public, so
-- `visibility = 'private' or student_id is not null` reads as `public => student`.
alter table app.teacher_note drop constraint if exists teacher_note_kind_check;
alter table app.teacher_note add constraint teacher_note_kind_check
  check (visibility = 'private' or student_id is not null);

comment on column app.teacher_note.student_id is
  'The student a note is about. Required for a public note (which that student '
  'reads); optional for a private note, where it is only a label for the author - '
  'a private note is never visible to the student it names. Whenever set, the '
  'author must have taught that student (teaches_student). See 0056, 0063.';

-- -----------------------------------------------------------------------------
-- 2. The roster rule applies whenever a student is named
-- -----------------------------------------------------------------------------
drop policy if exists teacher_note_author_insert on app.teacher_note;
create policy teacher_note_author_insert on app.teacher_note
  for insert to authenticated
  with check (
    teacher_note.author_teacher_id = app.current_teacher_id()
    and (
      teacher_note.student_id is null
      or app.teaches_student(teacher_note.student_id)
    )
  );

-- UPDATE keeps both halves, as in 0056: `using` picks the rows you may target (your
-- own), `with check` says what the row may become. The roster rule is in the second.
drop policy if exists teacher_note_author_update on app.teacher_note;
create policy teacher_note_author_update on app.teacher_note
  for update to authenticated
  using (teacher_note.author_teacher_id = app.current_teacher_id())
  with check (
    teacher_note.author_teacher_id = app.current_teacher_id()
    and (
      teacher_note.student_id is null
      or app.teaches_student(teacher_note.student_id)
    )
  );

-- =============================================================================
-- Trailing checks - run with the migration, read the NOTICEs
-- =============================================================================
-- The Supabase SQL editor does not surface NOTICEs, so every failure is also an
-- exception (the 0053 lesson).
do $$
declare
  v_count int;
  v_def   text;
begin
  -- The kind check must say `public => student`, and must no longer say that a
  -- private note has none.
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conname = 'teacher_note_kind_check'
    and c.conrelid = 'app.teacher_note'::regclass;

  if v_def is null then
    raise exception 'FAIL: teacher_note_kind_check missing';
  end if;
  if v_def not ilike '%student_id IS NOT NULL%' then
    raise exception 'FAIL: kind check no longer requires a student for a public note: %', v_def;
  end if;
  if v_def ilike '%student_id IS NULL%' then
    raise exception 'FAIL: kind check still forces a private note to have no student: %', v_def;
  end if;
  raise notice 'OK: kind check is "public needs a student", private is free';

  -- The write policies must check the roster whenever a student is named, and must
  -- no longer key that on the note's kind.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app' and tablename = 'teacher_note'
    and policyname in ('teacher_note_author_insert', 'teacher_note_author_update')
    and with_check like '%teaches_student%'
    and with_check not like '%visibility%';

  if v_count <> 2 then
    raise exception 'FAIL: expected insert and update to check the roster regardless of kind, found % that do', v_count;
  end if;
  raise notice 'OK: insert and update check the roster whenever a student is named';

  -- THE IMPORTANT ONE. The student's read policy must still be public-only: it is
  -- now the sole protection for a private note that names that student.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app' and tablename = 'teacher_note'
    and policyname = 'teacher_note_student_select'
    and qual like '%''public''%'
    and qual like '%current_student_id%'
    and qual like '%deleted_at%';

  if v_count <> 1 then
    raise exception 'FAIL: teacher_note_student_select no longer guards on visibility = public - a tagged private note would reach its student';
  end if;
  raise notice 'OK: the student still reads public notes only';

  -- No teacher_note policy reads a table inline (the 42P17 rule from 0055).
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app' and tablename = 'teacher_note'
    and (coalesce(qual, '') like '%FROM app.%' or coalesce(with_check, '') like '%FROM app.%');

  if v_count <> 0 then
    raise exception 'FAIL: % teacher_note policies read a table inline', v_count;
  end if;
  raise notice 'OK: no teacher_note policy reads a table inline';

  -- The full set is still four: two reads, insert, update. (0058 removed delete.)
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app' and tablename = 'teacher_note'
    and policyname in (
      'teacher_note_author_select', 'teacher_note_student_select',
      'teacher_note_author_insert', 'teacher_note_author_update'
    );

  if v_count <> 4 then
    raise exception 'FAIL: expected 4 teacher_note policies, found %', v_count;
  end if;

  select count(*) into v_count
  from pg_policies where schemaname = 'app' and tablename = 'teacher_note';

  if v_count <> 4 then
    raise exception 'FAIL: teacher_note carries % policies, expected exactly 4', v_count;
  end if;
  raise notice 'OK: the four teacher_note policies, and nothing else';
end $$;
