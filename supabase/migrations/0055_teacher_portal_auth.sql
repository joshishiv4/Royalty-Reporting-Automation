-- =============================================================================
-- 0055  Teacher sign-in, and the read-only roster behind it
--
-- WHY THIS EXISTS
--   Measured 9 Oct 2026, read-only against live: all 47 teachers hold an email
--   and an `identity` row, none has ever signed in, and not one can. Two
--   independent reasons, and fixing either alone is worse than fixing neither:
--
--     1. `identity_for_email()` joins `app.student` only, so a teacher's address
--        is refused before an email is attempted.
--     2. Every policy in `0053` resolves "me" through `current_student_id()`,
--        which is NULL for a teacher.
--
--   Widen only (1) and a teacher signs in perfectly and reads NOTHING - the
--   empty-dashboard outcome `/auth/verify` deliberately signs people out to
--   avoid. So the admission test and the policy set move together, here.
--
-- THE SCOPE IS READ-ONLY, BY DECISION OF 9 OCT 2026
--   Every policy below is `for select`. A teacher may read the roster they
--   taught; they may not mark attendance, write feedback or edit anything. This
--   database has no write policy at all, and the first one is a larger argument
--   than a migration should settle on its way past.
--
-- WHAT THE MEASUREMENT FOUND, BECAUSE IT SHAPED THE FUNCTION BELOW
--   All 47 teacher addresses ALSO sit on an `app.student` row, which looks fatal
--   for a "exactly one match" rule and is not. Exactly 47 student rows have no
--   identity, and they are the same 47 humans: WL carries a teacher as both a
--   staff record and a client record, `0040`'s trigger applied the `0039` rule -
--   staff profile type wins - and left the duplicate student row orphaned. An
--   orphaned student row is invisible to a join through `identity`, so a lookup
--   across both roles still returns one answer. No identity holds both roles;
--   `identity_one_role_check` is intact.
--
--   ONE TEACHER IS REFUSED BY THIS, AND IT IS LEFT THAT WAY ON PURPOSE. His
--   address is on one teacher row and TWO student rows, one of which carries its
--   own identity - two identities, so NULL, so the uniform 202 and no code. The
--   tempting fix is a tie-break ("prefer the teacher row"). It is the wrong
--   failure of the two available: it would mail a code to whoever holds that
--   address and sign them in AS THE TEACHER, handing one human's roster to
--   another. The honest remedies are a data fix - the second student row is a WL
--   duplicate, which is task 030's subject - or RUNBOOK §10a. Neither is code.
--
-- Depends on 0053 and 0054. Safe to re-run.
-- =============================================================================

-- =============================================================================
-- 1. The admission test, widened to either role
-- =============================================================================
-- UNCHANGED IN CONTRACT: same name, same argument, same return, still NULL for
-- zero AND for several, still `service_role` only. `link_signed_in_identity()`
-- calls this function and needs no edit at all - which is the entire reason
-- `0054` pulled the rule out of it. One statement of "is this address on the
-- roll", now spanning both rolls, and two callers that cannot drift apart.
--
-- WHY TWO COMPARISONS RATHER THAN `coalesce(s.email, t.email)`. The coalesce
-- reads as though it says the same thing and does not: it silently prefers the
-- student address whenever an identity somehow held both roles. That cannot
-- happen today - `identity_one_role_check` forbids it - but a rule that depends
-- on a constraint elsewhere staying true should say so out loud, and this one
-- would fail quietly if the constraint were ever dropped. The `or` below
-- degrades to "several matches, refuse", which is the safe direction.
--
-- A teacher with no email cannot match: `t.email` is NULL, the comparison is
-- NULL, the row is not counted. That is the same treatment the 17 emailless
-- students get, and it is correct - there is nowhere to send a code.

create or replace function app.identity_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 1 then (array_agg(i.id))[1] end
  from app.identity i
  left join app.student s on s.id = i.student_id
  left join app.teacher t on t.id = i.teacher_id
  where lower(trim(s.email)) = lower(trim(p_email))
     or lower(trim(t.email)) = lower(trim(p_email));
$$;

comment on function app.identity_for_email(text) is
  'The single identity whose student OR teacher row carries this address, or '
  'NULL when zero or several do. NULL is an answer, not an error - the caller '
  'must treat "no such address" and "ambiguous address" identically. Widened to '
  'the teacher role by 0055; 0054''s student-only contract is otherwise '
  'unchanged. service_role only: this answers whether an address is on the roll, '
  'which is what the sign-in form''s uniform reply exists to withhold.';

-- The grants are re-stated rather than assumed. `create or replace` keeps the
-- existing ones, but a reader of this file should not have to know that, and a
-- re-run on a database where 0054 was never applied would otherwise leave the
-- function reachable by `authenticated`.
revoke execute on function app.identity_for_email(text) from public;
revoke execute on function app.identity_for_email(text) from authenticated, anon;
grant  execute on function app.identity_for_email(text) to service_role;

-- =============================================================================
-- 2. "Me", as a teacher
-- =============================================================================
-- The exact mirror of `current_student_id()` from 0053, including the parts that
-- look like boilerplate and are not:
--
--   SECURITY DEFINER     - a policy looking this up inline would be filtered by
--                          the policy on `identity`.
--   set search_path = '' - an unpinned search_path on a definer function lets a
--                          caller who can create a schema shadow a table name.
--   NULL for a student   - and NULL must read as NO ROWS. Every policy below
--                          compares with `=`, so NULL yields NULL, never true.
--                          There is no `is null` anywhere in this file, and that
--                          is the single most important line in it: one such
--                          test would open every row to every signed-in student.

create or replace function app.current_teacher_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.teacher_id
  from app.identity i
  where i.auth_user_id = auth.uid()
  limit 1
$$;

comment on function app.current_teacher_id() is
  'The signed-in human''s teacher role id, or NULL. The mirror of '
  'current_student_id(): NULL for a student, NULL for an unlinked human, and '
  'NULL must mean no rows.';

revoke execute on function app.current_teacher_id() from public;
grant  execute on function app.current_teacher_id() to authenticated, service_role;

-- =============================================================================
-- 2b. Reachability, as THREE DEFINER FUNCTIONS rather than three subqueries
-- =============================================================================
-- AMENDED IN PLACE, 9 Oct 2026, AFTER THE FIRST VERSION WAS APPLIED AND BROKE.
-- The first draft wrote these as `exists (...)` subqueries inside the policies,
-- and carried a comment claiming "there is no cycle - class_session_teacher's
-- own policy names no table". THAT CLAIM WAS FALSE, and the database said so:
--
--   ERROR 42P17: infinite recursion detected in policy for relation
--                "attendance_record"
--
-- `0053`'s `class_session_teacher_attended_select` DOES name a table - it reads
-- `app.attendance_record` to answer "did you attend the session this row is
-- about". So the loop closed the moment this migration gave `attendance_record`
-- a policy that reads `class_session_teacher`:
--
--   attendance_record -> class_session_teacher -> attendance_record -> ...
--
-- It was not caught before applying because policies are not exercised by
-- anything in `npm run verify`; the only thing that runs them is the SQL editor.
--
-- AND IT WAS NOT ONLY THE TEACHER'S PROBLEM. `app.student` carries two
-- permissive policies now, OR'd, and one of them reached into that loop - so a
-- signed-in STUDENT could hit the same 42P17 depending on how the planner
-- ordered the OR. Sections A-F of the isolation check passed on the first run,
-- which proved only that it short-circuited for those rows.
--
-- THE FIX IS THE PATTERN 0053 ALREADY ESTABLISHED, applied one level further
-- out. 0053 made `current_student_id()` a definer function precisely because "a
-- policy's subquery runs as the caller": a definer function runs as the owner,
-- who is exempt from row security, so the tables it reads are read WITHOUT their
-- policies and no policy can re-enter another. The three below each answer one
-- question, about the caller only, and leak nothing a teacher could not already
-- see by asking the policy directly.

create or replace function app.teaches_session(p_class_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.class_session_teacher cst
    where cst.class_session_id = p_class_session_id
      and cst.teacher_id = app.current_teacher_id()
  )
$$;

comment on function app.teaches_session(uuid) is
  'Is the signed-in teacher named on this session? FALSE for a student, for an '
  'unlinked human, and for a teacher who is not on it. DEFINER so the policies '
  'using it do not re-enter class_session_teacher''s own policy - see 0055.';

create or replace function app.teaches_cohort(p_cohort_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.class_session cs
    join app.class_session_teacher cst on cst.class_session_id = cs.id
    where cs.cohort_id = p_cohort_id
      and cst.teacher_id = app.current_teacher_id()
  )
$$;

comment on function app.teaches_cohort(uuid) is
  'Has the signed-in teacher taught any session of this cohort? DEFINER, for the '
  'same reason as teaches_session().';

-- The roster test itself. This is the one that decides who a teacher can see.
create or replace function app.teaches_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.attendance_record ar
    join app.class_session_teacher cst on cst.class_session_id = ar.class_session_id
    where ar.student_id = p_student_id
      and cst.teacher_id = app.current_teacher_id()
  )
$$;

comment on function app.teaches_student(uuid) is
  'Has this student attended a session the signed-in teacher is named on? The '
  'roster rule, stated once. FALSE for a student caller, which is what keeps '
  '0053''s student policies unchanged in effect as well as in text.';

revoke execute on function app.teaches_session(uuid) from public;
revoke execute on function app.teaches_cohort(uuid)  from public;
revoke execute on function app.teaches_student(uuid) from public;

grant execute on function app.teaches_session(uuid) to authenticated, service_role;
grant execute on function app.teaches_cohort(uuid)  to authenticated, service_role;
grant execute on function app.teaches_student(uuid) to authenticated, service_role;

-- =============================================================================
-- 3. The roster
-- =============================================================================
-- EVERY POLICY HERE IS ADDED ALONGSIDE THE STUDENT POLICIES FROM 0053, NEVER IN
-- PLACE OF ONE. Two permissive policies on a table are OR'd, so a student's
-- reach is unchanged by construction - there is no edit to a student policy in
-- this file, and there must never be one. The cheap mistake this avoids is
-- rewriting `student_self_select` to say "me or my teacher", which silently
-- widens what a STUDENT reads while appearing to be about teachers.
--
-- `portal_auth_isolation.sql` section C is the proof, and it is required to pass
-- UNCHANGED after this migration. If it needed editing, this migration is wrong.
--
-- WHAT A TEACHER IS ALLOWED TO SEE, STATED ONCE: the humans who attended a
-- session they are named on. Not the studio's roll, not every teacher, not a
-- cohort they never taught. Every policy below is a different route to that one
-- sentence, and `class_session_teacher` is the join that carries it.
--
-- NO POLICY BELOW NAMES A TABLE. Every one is either a plain column comparison
-- or a call to a definer function from section 2b. That is not a style choice:
-- it is what makes a cycle impossible rather than merely absent today. The first
-- version of this migration used inline subqueries and deadlocked the policy
-- graph against `0053` - see 2b for exactly how, and what it would have cost.

-- teacher: your own row.
--
-- A SECOND policy on this table. 0053's `teacher_taught_select` lets a student
-- see the teachers who taught them; this lets a teacher see themselves. Neither
-- is "every teacher", and a teacher still cannot list their colleagues.
drop policy if exists teacher_self_select on app.teacher;
create policy teacher_self_select on app.teacher
  for select to authenticated
  using (teacher.id = app.current_teacher_id());

-- class_session_teacher: the rows that name you.
--
-- This is the root of every policy below it, so it is the one to read carefully.
-- It does NOT say "sessions I taught alongside others are visible in full" - a
-- co-teacher's row on the same session is a different row and is not matched
-- here. That is a real restriction, chosen rather than overlooked: a teacher's
-- roster is who attended, not who else was on staff that day.
drop policy if exists class_session_teacher_own_select on app.class_session_teacher;
create policy class_session_teacher_own_select on app.class_session_teacher
  for select to authenticated
  using (class_session_teacher.teacher_id = app.current_teacher_id());

-- class_session: the sessions you are named on.
drop policy if exists class_session_taught_select on app.class_session;
create policy class_session_taught_select on app.class_session
  for select to authenticated
  using (app.teaches_session(class_session.id));

-- cohort: the class groups those sessions belong to.
drop policy if exists cohort_taught_select on app.cohort;
create policy cohort_taught_select on app.cohort
  for select to authenticated
  using (app.teaches_cohort(cohort.id));

-- attendance_record: who turned up to those sessions.
-- THIS IS THE POLICY THAT CLOSED THE LOOP in the first version, by reading
-- class_session_teacher inline. Through the definer function it reads nothing.
drop policy if exists attendance_record_taught_select on app.attendance_record;
create policy attendance_record_taught_select on app.attendance_record
  for select to authenticated
  using (app.teaches_session(attendance_record.class_session_id));

-- student: THE ROSTER. The one policy this whole task exists to add.
--
-- A student becomes visible to a teacher by having attended a session that
-- teacher is named on, and stops being visible the moment that is not true. It
-- is reachability through attendance, not enrolment and not membership: a
-- student who enrolled and never came is not on anybody's roster, which is the
-- honest answer and is what `attendance_record` can actually prove.
--
-- This is the widest policy in the file. A teacher with many sessions sees many
-- students, which is the point; what they cannot do is see one student they
-- never taught.
-- AND THIS IS THE ONE THAT MADE IT A STUDENT'S PROBLEM TOO. `app.student` now
-- carries two permissive policies, OR'd, and in the first version this half
-- reached into the recursive loop - so a plain student read could fail with
-- 42P17 depending on how the planner ordered the OR. A teacher-shaped mistake
-- that landed on students: the strongest argument in this file for the rule
-- that a policy here names no table.
drop policy if exists student_taught_select on app.student;
create policy student_taught_select on app.student
  for select to authenticated
  using (app.teaches_student(student.id));

-- =============================================================================
-- 4. What is deliberately NOT here
-- =============================================================================
-- NO POLICY ON `app.identity`. 0053's `identity_self_select` is
-- `auth_user_id = auth.uid()` - it never mentioned the student role, so it
-- already answers for a teacher. Adding a teacher-shaped copy would be a second
-- definition of "my own row" to keep in step with the first.
--
-- NO GRANTS. 0047 gave the `app` tables to `service_role` only and 0053 granted
-- SELECT on all ten to `authenticated`. A policy without a grant fails with
-- "permission denied", which looks like a policy bug and is not; there is
-- nothing to add here, and nothing above needs it.
--
-- NO POLICY ON `app.creation`. A teacher reading student uploads is a plausible
-- next step and is NOT in this task's scope - it is a different question (whose
-- work, shown to whom) and deserves to be asked rather than inherited from a
-- roster policy.
--
-- NOTHING ON THE `public` WL MIRROR. Those five policies run through
-- `current_wl_uid()` and are about a person's own purchases and attendance in
-- WellnessLiving. A teacher's roster is an `app`-schema question.

-- =============================================================================
-- 5. Trailing checks - run with the migration, read the NOTICEs
-- =============================================================================
do $$
declare
  v_count int;
begin
  -- The definer functions must have search_path pinned. 0053 makes this check
  -- on its own five; the same reasoning applies to the one added here.
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app'
    and p.proname in ('current_teacher_id', 'identity_for_email',
                      'teaches_session', 'teaches_cohort', 'teaches_student')
    and p.prosecdef
    and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%';

  if v_count <> 5 then
    raise exception 'FAIL: expected 5 definer functions with a pinned search_path, found %', v_count;
  end if;
  raise notice 'OK: all five functions are definer with search_path pinned';

  -- NO POLICY ADDED HERE MAY NAME A TABLE. This is the check that would have
  -- caught the 42P17 before it reached the database, and it is worth more than
  -- the comment explaining the rule: a policy expression mentioning `app.` is
  -- reading a table, and a table it reads has policies of its own that may read
  -- back. The three definer functions exist so this can be asserted.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app'
    and policyname in (
      'teacher_self_select', 'class_session_teacher_own_select',
      'class_session_taught_select', 'cohort_taught_select',
      'attendance_record_taught_select', 'student_taught_select'
    )
    and qual like '%FROM app.%';

  if v_count <> 0 then
    raise exception 'FAIL: % of this migration''s policies read a table inline - that is how 42P17 happened', v_count;
  end if;
  raise notice 'OK: no policy added here reads a table inline';

  -- EVERY policy added by this migration must be SELECT. This is the check that
  -- would catch a write policy arriving later by accident, which is the thing
  -- the read-only decision is worth defending.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app'
    and policyname in (
      'teacher_self_select', 'class_session_teacher_own_select',
      'class_session_taught_select', 'cohort_taught_select',
      'attendance_record_taught_select', 'student_taught_select'
    )
    and cmd <> 'SELECT';

  if v_count <> 0 then
    raise exception 'FAIL: % of this migration''s policies are not SELECT', v_count;
  end if;
  raise notice 'OK: all six teacher policies are SELECT only';

  -- The student policies from 0053 must still be there, untouched. If one went
  -- missing, this migration edited something it had no business editing.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app'
    and policyname in (
      'student_self_select', 'attendance_record_self_select',
      'class_session_attended_select', 'cohort_attended_select',
      'class_session_teacher_attended_select', 'teacher_taught_select'
    );

  if v_count <> 6 then
    raise exception 'FAIL: expected 0053''s 6 student policies intact, found %', v_count;
  end if;
  raise notice 'OK: 0053''s student policies are all still present';
end $$;
