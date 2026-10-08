-- =============================================================================
-- Portal auth isolation proof - two students, and neither can read the other
--
-- RUNS INSIDE A TRANSACTION AND ROLLS BACK. It creates students, a class, the
-- attendance joining them, and then signs in as each one in turn. Nothing
-- survives.
--
-- WHY IT CREATES ROWS RATHER THAN ASSERTING ON REAL ONES. A policy that returns
-- zero rows passes "cannot see another student's data" for the wrong reason - it
-- also returns zero for your own. Proving isolation needs at least two owners
-- and real rows on both sides, so the test makes them. The same argument is in
-- rls_isolation_test.sql, which proves the same thing about the WellnessLiving
-- mirror; this file is about the portal's own tables in `app`.
--
-- HOW THE USER IS FAKED. auth.uid() reads the `sub` claim out of
-- request.jwt.claims, and auth.jwt() reads the whole object. Setting that GUC and
-- switching to the `authenticated` role is exactly what PostgREST does per
-- request, so the policies are exercised the way the portal will exercise them -
-- including the email claim the link function depends on.
--
-- THIS TEST CAN FAIL. That is the point of it. To prove it is not passing by
-- accident, drop one policy and run it again:
--
--     drop policy student_self_select on app.student;        -- section A goes red
--     drop policy attendance_record_self_select on app.attendance_record;
--                                                            -- A and B go red
--     drop policy class_session_attended_select on app.class_session;
--                                                            -- B goes red
--
-- Restore by re-running 0053, which is safe to re-run.
--
-- Requires 0053. Run as postgres / the SQL editor. Read the NOTICEs; any FAIL is
-- real.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- The cast.
--
-- Alice and Bob are PORTAL-NATIVE: identity.uid is null and neither has a
-- `person` row. That is deliberate - it proves the hub answers for a human
-- WellnessLiving has never heard of, which is the case the hub exists for.
--
-- Carol One and Carol Two share an address, which is not a contrivance: 51
-- addresses in this database sit on more than one student row and the worst is
-- shared by 16. Dave has an address of his own and no link yet.
-- -----------------------------------------------------------------------------
insert into app.student (id, first_name, last_name, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice', '__pa_test', '__pa_alice@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob',   '__pa_test', '__pa_bob@test.invalid'),
  ('cccccccc-0000-0000-0000-000000000003', 'carol', '__pa_one',  '__pa_shared@test.invalid'),
  ('cccccccc-0000-0000-0000-000000000004', 'carol', '__pa_two',  '__pa_shared@test.invalid'),
  ('dddddddd-0000-0000-0000-000000000005', 'dave',  '__pa_test', '__pa_dave@test.invalid');

insert into app.teacher (id, first_name, last_name, email) values
  ('0e0e0e0e-0000-0000-0000-000000000001', 'tina',  '__pa_test', '__pa_tina@test.invalid'),
  ('0e0e0e0e-0000-0000-0000-000000000002', 'trevor','__pa_test', '__pa_trevor@test.invalid');

-- The identities. Alice and Bob are signed in; Carol One, Carol Two and Dave are
-- not linked to anything yet, which is what the link function is tested against.
insert into app.identity (id, student_id, auth_user_id) values
  ('a1a1a1a1-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111'),
  ('b1b1b1b1-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222'),
  ('c1c1c1c1-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000003', null),
  ('c1c1c1c1-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000004', null),
  ('d1d1d1d1-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-000000000005', null);

-- Two cohorts, two sessions, two teachers. One of each per student, so every
-- "you see yours" assertion has a matching "and not theirs" to fail on.
insert into app.cohort (id, title) values
  ('c0c0c0c0-0000-0000-0000-000000000001', '__pa_alice_cohort'),
  ('c0c0c0c0-0000-0000-0000-000000000002', '__pa_bob_cohort');

insert into app.class_session (id, cohort_id, title, starts_at) values
  ('5e551011-0000-0000-0000-000000000001', 'c0c0c0c0-0000-0000-0000-000000000001',
   '__pa_alice_session', now() + interval '1 day'),
  ('5e551011-0000-0000-0000-000000000002', 'c0c0c0c0-0000-0000-0000-000000000002',
   '__pa_bob_session',   now() + interval '2 days');

insert into app.class_session_teacher (class_session_id, teacher_id) values
  ('5e551011-0000-0000-0000-000000000001', '0e0e0e0e-0000-0000-0000-000000000001'),
  ('5e551011-0000-0000-0000-000000000002', '0e0e0e0e-0000-0000-0000-000000000002');

insert into app.attendance_record (class_session_id, student_id, is_attended) values
  ('5e551011-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', true),
  ('5e551011-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', true);

insert into app.creation (student_id, storage_path, original_filename, uploaded_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '__pa_alice_file', 'alice.wav', now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', '__pa_bob_file',   'bob.wav',   now());

-- Alice belongs to the organization; Bob deliberately does not, so the
-- membership helper has something to be wrong about.
insert into app.organization_membership (organization_id, identity_id, role, status)
select o.id, 'a1a1a1a1-0000-0000-0000-000000000001', 'participant', 'active'
from app.organization o where o.is_active limit 1;

do $$
declare
  alice_auth uuid := '11111111-1111-1111-1111-111111111111';
  bob_auth   uuid := '22222222-2222-2222-2222-222222222222';
  dave_auth  uuid := '44444444-4444-4444-4444-444444444444';
  eve_auth   uuid := '55555555-5555-5555-5555-555555555555';
  n          int;
  who        text;
  got        uuid;
  again      uuid;
  failures   int := 0;
begin
  -- ===========================================================================
  -- A. The student's own row
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice_auth, 'email', '__pa_alice@test.invalid')::text, true);
  set local role authenticated;

  select count(*), coalesce(string_agg(first_name, ','), '(none)')
    into n, who
    from app.student where last_name like '__pa_%';

  if n = 1 and who = 'alice' then
    raise notice 'PASS  A1  alice sees 1 student row, and it is alice';
  else
    failures := failures + 1;
    raise notice 'FAIL  A1  alice sees % student rows (%), expected exactly 1 (alice)', n, who;
  end if;

  -- The helpers resolve her, which is what every policy below depends on.
  if app.current_student_id() = 'aaaaaaaa-0000-0000-0000-000000000001' then
    raise notice 'PASS  A2  current_student_id() resolves alice';
  else
    failures := failures + 1;
    raise notice 'FAIL  A2  current_student_id() returned %, expected alice', app.current_student_id();
  end if;

  -- Portal-native: no WellnessLiving uid, and that must read as NULL rather than
  -- as an error or a guess.
  if app.current_wl_uid() is null then
    raise notice 'PASS  A3  a portal-native student has no WL uid, and says so';
  else
    failures := failures + 1;
    raise notice 'FAIL  A3  current_wl_uid() returned %, expected NULL', app.current_wl_uid();
  end if;

  -- ===========================================================================
  -- B. Everything hanging off the student
  -- ===========================================================================
  select count(*) into n from app.attendance_record
   where class_session_id in ('5e551011-0000-0000-0000-000000000001',
                              '5e551011-0000-0000-0000-000000000002');
  if n = 1 then
    raise notice 'PASS  B1  alice sees 1 attendance row, not bob''s';
  else
    failures := failures + 1;
    raise notice 'FAIL  B1  alice sees % attendance rows, expected 1', n;
  end if;

  select coalesce(string_agg(title, ','), '(none)') into who
    from app.class_session where title like '__pa_%';
  if who = '__pa_alice_session' then
    raise notice 'PASS  B2  alice sees only her own session';
  else
    failures := failures + 1;
    raise notice 'FAIL  B2  alice sees sessions [%], expected __pa_alice_session', who;
  end if;

  select coalesce(string_agg(title, ','), '(none)') into who
    from app.cohort where title like '__pa_%';
  if who = '__pa_alice_cohort' then
    raise notice 'PASS  B3  alice sees only her own cohort';
  else
    failures := failures + 1;
    raise notice 'FAIL  B3  alice sees cohorts [%], expected __pa_alice_cohort', who;
  end if;

  -- The staff list is NOT public to a student. She may see the one who taught her.
  select coalesce(string_agg(first_name, ','), '(none)') into who
    from app.teacher where last_name like '__pa_%';
  if who = 'tina' then
    raise notice 'PASS  B4  alice sees the teacher who taught her, and no others';
  else
    failures := failures + 1;
    raise notice 'FAIL  B4  alice sees teachers [%], expected tina alone', who;
  end if;

  select coalesce(string_agg(storage_path, ','), '(none)') into who
    from app.creation where storage_path like '__pa_%';
  if who = '__pa_alice_file' then
    raise notice 'PASS  B5  alice sees only her own upload';
  else
    failures := failures + 1;
    raise notice 'FAIL  B5  alice sees uploads [%], expected __pa_alice_file', who;
  end if;

  -- The membership helper. Alice is a member; Bob is not.
  select count(*) into n from app.organization;
  if n = 1 then
    raise notice 'PASS  B6  alice sees the organization she belongs to';
  else
    failures := failures + 1;
    raise notice 'FAIL  B6  alice sees % organizations, expected 1', n;
  end if;

  reset role;

  -- ===========================================================================
  -- C. The mirror image, so a policy that hardcodes one user cannot pass by luck
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob_auth, 'email', '__pa_bob@test.invalid')::text, true);
  set local role authenticated;

  select coalesce(string_agg(first_name, ','), '(none)') into who
    from app.student where last_name like '__pa_%';
  if who = 'bob' then
    raise notice 'PASS  C1  bob sees only bob';
  else
    failures := failures + 1;
    raise notice 'FAIL  C1  bob sees [%], expected bob', who;
  end if;

  select coalesce(string_agg(title, ','), '(none)') into who
    from app.class_session where title like '__pa_%';
  if who = '__pa_bob_session' then
    raise notice 'PASS  C2  bob sees only his own session';
  else
    failures := failures + 1;
    raise notice 'FAIL  C2  bob sees sessions [%], expected __pa_bob_session', who;
  end if;

  -- Bob has no membership. He must see no organization - not "the only one".
  select count(*) into n from app.organization;
  if n = 0 then
    raise notice 'PASS  C3  bob belongs to no organization and sees none';
  else
    failures := failures + 1;
    raise notice 'FAIL  C3  bob sees % organizations, expected 0', n;
  end if;

  reset role;

  -- ===========================================================================
  -- D. Signed out
  -- ===========================================================================
  perform set_config('request.jwt.claims', NULL, true);
  set local role anon;

  select count(*) into n from app.student where last_name like '__pa_%';
  if n = 0 then
    raise notice 'PASS  D1  anon sees 0 student rows';
  else
    failures := failures + 1;
    raise notice 'FAIL  D1  anon sees % student rows, expected 0', n;
  end if;

  reset role;

  -- ===========================================================================
  -- E. The first sign-in link
  -- ===========================================================================
  -- Dave: one address, one student, not yet linked. The happy path.
  perform set_config('request.jwt.claims',
    json_build_object('sub', dave_auth, 'email', '__pa_dave@test.invalid')::text, true);
  set local role authenticated;

  begin
    got := app.link_signed_in_identity();
    if got = 'd1d1d1d1-0000-0000-0000-000000000005' then
      raise notice 'PASS  E1  a unique address links to exactly one identity';
    else
      failures := failures + 1;
      raise notice 'FAIL  E1  linked to %, expected dave', got;
    end if;
  exception when others then
    failures := failures + 1;
    raise notice 'FAIL  E1  link raised % for a unique address', sqlerrm;
  end;

  -- Called twice. A retried request after a dropped response must not read as a
  -- collision.
  begin
    again := app.link_signed_in_identity();
    if again = got then
      raise notice 'PASS  E2  linking twice returns the same identity';
    else
      failures := failures + 1;
      raise notice 'FAIL  E2  second call returned %, expected %', again, got;
    end if;
  exception when others then
    failures := failures + 1;
    raise notice 'FAIL  E2  second call raised %, expected the same identity', sqlerrm;
  end;

  reset role;

  -- Eve: her address is on TWO student rows. This is the case that would hand one
  -- human another's data, and it must refuse rather than pick.
  perform set_config('request.jwt.claims',
    json_build_object('sub', eve_auth, 'email', '__pa_shared@test.invalid')::text, true);
  set local role authenticated;

  begin
    got := app.link_signed_in_identity();
    failures := failures + 1;
    raise notice 'FAIL  E3  an ambiguous address linked to %, expected a refusal', got;
  exception when others then
    if sqlerrm like '%no_single_identity%' then
      raise notice 'PASS  E3  an address on two students is refused, not guessed';
    else
      failures := failures + 1;
      raise notice 'FAIL  E3  refused with the wrong error: %', sqlerrm;
    end if;
  end;

  reset role;

  -- An address nobody holds. Same refusal, deliberately indistinguishable - the
  -- caller must not be able to tell "no such student" from "too many".
  perform set_config('request.jwt.claims',
    json_build_object('sub', eve_auth, 'email', '__pa_nobody@test.invalid')::text, true);
  set local role authenticated;

  begin
    got := app.link_signed_in_identity();
    failures := failures + 1;
    raise notice 'FAIL  E4  an unknown address linked to %, expected a refusal', got;
  exception when others then
    if sqlerrm like '%no_single_identity%' then
      raise notice 'PASS  E4  an unknown address is refused with the SAME error as E3';
    else
      failures := failures + 1;
      raise notice 'FAIL  E4  refused with the wrong error: %', sqlerrm;
    end if;
  end;

  reset role;

  -- ===========================================================================
  -- F. One auth user cannot hold two identities
  -- ===========================================================================
  -- Proven by attempting it, not by reading the index definition. Dave's auth
  -- user is already linked by E1; claiming Carol One as well must fail.
  begin
    update app.identity
       set auth_user_id = dave_auth
     where id = 'c1c1c1c1-0000-0000-0000-000000000003';

    failures := failures + 1;
    raise notice 'FAIL  F1  one auth user now holds two identities';
  exception when unique_violation then
    raise notice 'PASS  F1  a second identity for the same auth user is rejected';
  end;

  -- ===========================================================================
  if failures = 0 then
    raise notice '---- ALL PASSED: a student reads their own rows and nobody else''s ----';
  else
    raise exception '% portal auth check(s) FAILED - see the notices above', failures;
  end if;
end
$$;

-- Nothing is kept.
rollback;

-- Belt and braces: prove the test data really is gone. Expect ZERO rows.
select id, first_name, last_name from app.student where last_name like '__pa_%';
