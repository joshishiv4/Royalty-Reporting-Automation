-- =============================================================================
-- Quiz isolation proof - a student reads only their own attempts, answers and
-- suggestions, and cannot write any of them
--
-- RUNS INSIDE A TRANSACTION AND ROLLS BACK. It creates two students, a question
-- with an option, and an attempt + answer + suggestion for each, then signs in as
-- each and checks what they can see and do. Nothing survives.
--
-- WHY IT WRITES THE TEST ROWS AS POSTGRES. The real write path is service-role
-- (0059): attempts/answers/suggestions are written by the server with the
-- student id resolved from the caller's JWT, and `authenticated` has NO insert
-- privilege. So the setup inserts as the owner (bypassing RLS), exactly as the
-- server would, and the signed-in checks exercise only the SELECT policies - plus
-- one check that a student insert is refused, which is the point of the design.
--
-- THIS TEST CAN FAIL. To prove it is not passing by accident:
--     drop policy quiz_attempt_self_select on app.quiz_attempt;   -- A1 red
--     grant insert on app.quiz_attempt to authenticated;          -- D1 red
--
-- Requires 0048, 0053, 0059. Run as postgres / the SQL editor. Read the NOTICEs.
-- =============================================================================

begin;

insert into app.student (id, first_name, last_name, email) values
  ('50000000-0000-0000-0000-0000000000a1', 'sam',  '__qz_test', '__qz_sam@test.invalid'),
  ('50000000-0000-0000-0000-0000000000b1', 'sara', '__qz_test', '__qz_sara@test.invalid');

insert into app.identity (id, student_id, auth_user_id) values
  ('51000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a1',
   '5a000000-0000-0000-0000-00000000aaaa'),
  ('51000000-0000-0000-0000-0000000000b1', '50000000-0000-0000-0000-0000000000b1',
   '5b000000-0000-0000-0000-00000000bbbb');

insert into app.quiz_question (id, code, prompt, sort) values
  ('52000000-0000-0000-0000-000000000001', '__qz_q', '__qz question?', 1);

insert into app.quiz_option (id, code, question_id, label, sort) values
  ('53000000-0000-0000-0000-000000000001', '__qz_o',
   '52000000-0000-0000-0000-000000000001', '__qz option', 1);

-- One attempt each, written as the owner (what the server does).
insert into app.quiz_attempt (id, student_id) values
  ('54000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a1'),
  ('54000000-0000-0000-0000-0000000000b1', '50000000-0000-0000-0000-0000000000b1');

insert into app.quiz_answer (attempt_id, question_id, option_id, student_id) values
  ('54000000-0000-0000-0000-0000000000a1', '52000000-0000-0000-0000-000000000001',
   '53000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000a1'),
  ('54000000-0000-0000-0000-0000000000b1', '52000000-0000-0000-0000-000000000001',
   '53000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000b1');

insert into app.quiz_suggestion (attempt_id, student_id, course_title, rationale, model) values
  ('54000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a1',
   '__qz Sam Course', 'because', 'test-model'),
  ('54000000-0000-0000-0000-0000000000b1', '50000000-0000-0000-0000-0000000000b1',
   '__qz Sara Course', 'because', 'test-model');

do $$
declare
  sam_auth  uuid := '5a000000-0000-0000-0000-00000000aaaa';
  sara_auth uuid := '5b000000-0000-0000-0000-00000000bbbb';
  n         int;
  who       text;
  failures  int := 0;
  fails     text[] := '{}';
begin
  -- ===========================================================================
  -- A. sam sees his own attempt / answer / suggestion, and only his
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', sam_auth, 'email', '__qz_sam@test.invalid')::text, true);
  set local role authenticated;

  select count(*) into n from app.quiz_attempt;
  if n = 1 then
    raise notice 'PASS  A1  sam sees 1 attempt (his)';
  else
    failures := failures + 1;
    fails := fails || format('FAIL A1 sam sees %s attempts, expected 1', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  select coalesce(string_agg(course_title, ','), '(none)') into who from app.quiz_suggestion;
  if who = '__qz Sam Course' then
    raise notice 'PASS  A2  sam sees only his own suggestion';
  else
    failures := failures + 1;
    fails := fails || format('FAIL A2 sam sees suggestions [%s], expected his', who);
    raise notice '%', fails[cardinality(fails)];
  end if;

  select count(*) into n from app.quiz_answer;
  if n = 1 then
    raise notice 'PASS  A3  sam sees 1 answer (his)';
  else
    failures := failures + 1;
    fails := fails || format('FAIL A3 sam sees %s answers, expected 1', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- The quiz itself is readable.
  select count(*) into n from app.quiz_question where code = '__qz_q';
  if n = 1 then
    raise notice 'PASS  A4  sam can read the active question';
  else
    failures := failures + 1;
    fails := fails || format('FAIL A4 sam sees %s of the test question, expected 1', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- ===========================================================================
  -- D. a student cannot WRITE an attempt - authenticated holds no insert grant
  -- ===========================================================================
  begin
    insert into app.quiz_attempt (student_id)
    values ('50000000-0000-0000-0000-0000000000a1');
    failures := failures + 1;
    fails := fails || 'FAIL D1 sam inserted an attempt - writes are not service-role only';
    raise notice '%', fails[cardinality(fails)];
  exception when insufficient_privilege then
    raise notice 'PASS  D1  a student cannot insert an attempt';
  end;

  reset role;

  -- ===========================================================================
  -- C. sara sees only hers (the mirror, so no policy hardcodes one student)
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', sara_auth, 'email', '__qz_sara@test.invalid')::text, true);
  set local role authenticated;

  select coalesce(string_agg(course_title, ','), '(none)') into who from app.quiz_suggestion;
  if who = '__qz Sara Course' then
    raise notice 'PASS  C1  sara sees only her own suggestion';
  else
    failures := failures + 1;
    fails := fails || format('FAIL C1 sara sees suggestions [%s], expected hers', who);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ===========================================================================
  -- E. signed out - revoked on schema app (0053), so a refusal, not a filter
  -- ===========================================================================
  perform set_config('request.jwt.claims', NULL, true);
  begin
    set local role anon;
    select count(*) into n from app.quiz_attempt;
    failures := failures + 1;
    fails := fails || format('FAIL E1 anon read quiz_attempt and saw %s rows', n);
    raise notice '%', fails[cardinality(fails)];
  exception when insufficient_privilege then
    raise notice 'PASS  E1  anon is refused';
  end;
  reset role;

  if failures = 0 then
    raise notice '---- ALL PASSED: a student reads only their own quiz data and writes none ----';
  else
    raise exception E'% quiz isolation check(s) FAILED:\n%',
      failures, array_to_string(fails, E'\n');
  end if;
end $$;

rollback;

-- Belt and braces: the test rows are gone. Expect ZERO.
select id, course_title from app.quiz_suggestion where course_title like '\_\_qz %';
