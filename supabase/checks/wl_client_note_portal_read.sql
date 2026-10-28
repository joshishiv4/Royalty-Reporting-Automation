-- =============================================================================
-- wl_client_note portal read proof (0065) - a teacher reads the notes of the
-- students they teach, a student reads their own, and nobody reads more
--
-- RUNS INSIDE A TRANSACTION AND ROLLS BACK. Nothing survives.
--
-- THE CAST. tina teaches; alice attended tina's session, bob did not. alice and
-- bob are WellnessLiving clients (person rows), each with a note. Their student
-- role comes from 0040's person_identity_insert trigger, exactly as a synced
-- client's does - which is the uid -> identity -> student path the two functions
-- walk. A test login_type (is_teacher_type false) is what makes the trigger give
-- them the student role.
--
-- WHY EVERY "SEES NOTHING" IS PAIRED WITH A "SEES SOMETHING". A function that
-- returns zero rows for everybody passes every isolation line for the wrong
-- reason. So T1 and S1/S3 prove the doors open for the right person before the
-- other lines prove they stay shut for everyone else.
--
-- HOW THE USER IS FAKED. request.jwt.claims + `set local role authenticated`, as
-- in teacher_note_isolation.sql.
--
-- THIS TEST CAN FAIL. EXPECTED, not yet measured - if one does NOT go red, that
-- is a finding:
--
--   * my_students_wl_notes without `and app.teaches_student(i.student_id)`
--                                                      -> T1 red (tina sees bob)
--   * my_wl_note with `i.student_id = i.student_id` instead of
--     `= app.current_student_id()`                     -> S1, S3 red
--   * create policy x on public.wl_client_note
--       for select to authenticated using (true);      -> S4 red
--   * grant execute on function app.my_wl_note() to anon;
--                                                      -> A1 red
--   * 0065 re-run after 0066 (the date comes back)     -> D1, D2 red
--
-- Restore by re-running 0065 then 0066 (and dropping any added policy).
-- Requires 0040, 0053, 0055, 0064, 0065 and 0066. Run as postgres / the SQL
-- editor.
-- =============================================================================

begin;

insert into public.login_type (k_login_type, k_business, title, is_teacher_type)
values ('__wcp_type', '__wcp_biz', '__wcp student type', false);

insert into public.person (uid, k_business, first_name, last_name, k_login_type, ghl_match_state)
values
  ('__wcp_alice', '__wcp_biz', 'alice', '__wcp_test', '__wcp_type', 'unmatched'),
  ('__wcp_bob',   '__wcp_biz', 'bob',   '__wcp_test', '__wcp_type', 'unmatched');

update app.identity set auth_user_id = 'aaaa1111-0000-0000-0000-0000000000c1'
 where uid = '__wcp_alice';
update app.identity set auth_user_id = 'bbbb1111-0000-0000-0000-0000000000c1'
 where uid = '__wcp_bob';

insert into app.teacher (id, first_name, last_name, email) values
  ('0e0e0e0e-0000-0000-0000-0000000000c1', 'tina', '__wcp_test', '__wcp_tina@test.invalid');
insert into app.identity (id, teacher_id, auth_user_id) values
  ('7e7e7e7e-0000-0000-0000-0000000000c1', '0e0e0e0e-0000-0000-0000-0000000000c1',
   'aaaa0000-0000-0000-0000-0000000000c1');

insert into app.cohort (id, title) values
  ('c0c0c0c0-0000-0000-0000-0000000000c1', '__wcp_cohort');
insert into app.class_session (id, cohort_id, title, starts_at) values
  ('5e551011-0000-0000-0000-0000000000c1', 'c0c0c0c0-0000-0000-0000-0000000000c1',
   '__wcp_session', now() - interval '1 day');
insert into app.class_session_teacher (class_session_id, teacher_id) values
  ('5e551011-0000-0000-0000-0000000000c1', '0e0e0e0e-0000-0000-0000-0000000000c1');

-- alice on tina's roster. bob attended nothing of tina's.
insert into app.attendance_record (class_session_id, student_id, is_attended)
select '5e551011-0000-0000-0000-0000000000c1', i.student_id, true
  from app.identity i where i.uid = '__wcp_alice';

insert into public.wl_client_note (uid, k_business, note_html, note_text, synced_at)
values
  ('__wcp_alice', '__wcp_biz', '<p>alice discount</p>', 'alice discount', now()),
  ('__wcp_bob',   '__wcp_biz', '<p>bob discount</p>',   'bob discount',   now());

do $$
declare
  tina_auth  uuid := 'aaaa0000-0000-0000-0000-0000000000c1';
  alice_auth uuid := 'aaaa1111-0000-0000-0000-0000000000c1';
  bob_auth   uuid := 'bbbb1111-0000-0000-0000-0000000000c1';
  n          int;
  got        text;
  failures   int := 0;
  fails      text[] := '{}';

  procedure_ok boolean;
begin
  -- Precondition: the trigger really made alice and bob students. Without it,
  -- every student line below would pass on a function that cannot find anybody.
  select count(*) into n from app.identity
   where uid in ('__wcp_alice', '__wcp_bob') and student_id is not null;
  if n <> 2 then
    raise exception 'precondition: expected 2 student identities for the test clients, found %', n;
  end if;

  -- ===========================================================================
  -- T. tina, a teacher
  -- ===========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', tina_auth)::text, true);
  set local role authenticated;

  select count(*), string_agg(note_text || ' / ' || coalesce(student_name, '?'), ', ')
    into n, got
    from app.my_students_wl_notes()
   where note_text like '% discount';
  if n = 1 and got = 'alice discount / alice __wcp_test' then
    raise notice 'PASS  T1 tina sees alice''s note, tagged alice, and not bob''s';
  else
    failures := failures + 1;
    fails := fails || format('FAIL T1 tina sees %s note(s): %s - expected only alice''s', n, coalesce(got, '(none)'));
    raise notice '%', fails[cardinality(fails)];
  end if;

  select count(*) into n from app.my_wl_note();
  if n = 0 then
    raise notice 'PASS  T2 tina has no "own" student note';
  else
    failures := failures + 1;
    fails := fails || format('FAIL T2 tina sees %s row(s) from my_wl_note, expected 0', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ===========================================================================
  -- S. alice and bob, students
  -- ===========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', alice_auth)::text, true);
  set local role authenticated;

  select count(*), string_agg(note_text, ', ') into n, got from app.my_wl_note();
  if n = 1 and got = 'alice discount' then
    raise notice 'PASS  S1 alice sees her own note';
  else
    failures := failures + 1;
    fails := fails || format('FAIL S1 alice sees %s note(s): %s - expected only her own', n, coalesce(got, '(none)'));
    raise notice '%', fails[cardinality(fails)];
  end if;

  select count(*) into n from app.my_students_wl_notes();
  if n = 0 then
    raise notice 'PASS  S2 alice, not a teacher, gets nothing from the teacher function';
  else
    failures := failures + 1;
    fails := fails || format('FAIL S2 alice sees %s row(s) from my_students_wl_notes, expected 0', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- The table itself is still closed: the function is the only door.
  select count(*) into n from public.wl_client_note where uid like '\_\_wcp\_%';
  if n = 0 then
    raise notice 'PASS  S4 alice reads no row from the table directly';
  else
    failures := failures + 1;
    fails := fails || format('FAIL S4 alice reads %s wl_client_note row(s) directly, expected 0', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', bob_auth)::text, true);
  set local role authenticated;

  select count(*), string_agg(note_text, ', ') into n, got from app.my_wl_note();
  if n = 1 and got = 'bob discount' then
    raise notice 'PASS  S3 bob sees his own note, not alice''s';
  else
    failures := failures + 1;
    fails := fails || format('FAIL S3 bob sees %s note(s): %s - expected only his own', n, coalesce(got, '(none)'));
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ===========================================================================
  -- A. anon
  -- ===========================================================================
  perform set_config('request.jwt.claims', NULL, true);
  set local role anon;
  begin
    select count(*) into n from app.my_wl_note();
    procedure_ok := (n = 0);
  exception when insufficient_privilege then
    procedure_ok := true;  -- refused outright is the expected answer
  end;
  reset role;

  if procedure_ok then
    raise notice 'PASS  A1 anon gets no note';
  else
    failures := failures + 1;
    fails := fails || format('FAIL A1 anon read %s note(s)', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- ===========================================================================
  -- D. no date (0066): WL gives none, so neither the table nor a door has one
  -- ===========================================================================
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'wl_client_note'
     and column_name = 'note_seen_at';
  if n = 0 then
    raise notice 'PASS  D1 wl_client_note has no note_seen_at';
  else
    failures := failures + 1;
    fails := fails || 'FAIL D1 wl_client_note.note_seen_at exists - was 0065 re-run after 0066?';
    raise notice '%', fails[cardinality(fails)];
  end if;

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app'
     and p.proname in ('my_students_wl_notes', 'my_wl_note')
     and 'note_seen_at' = any (coalesce(p.proargnames, '{}'));
  if n = 0 then
    raise notice 'PASS  D2 neither note function returns a date';
  else
    failures := failures + 1;
    fails := fails || format('FAIL D2 %s note function(s) still return note_seen_at', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  if failures = 0 then
    raise notice '---- ALL PASSED: teachers read their students'' notes, students their own ----';
  else
    raise exception E'% wl_client_note portal-read check(s) FAILED:\n%',
      failures, array_to_string(fails, E'\n');
  end if;
end
$$;

rollback;

-- Prove the test data is gone. Expect ZERO rows.
select uid from public.person where uid like '\_\_wcp\_%';
