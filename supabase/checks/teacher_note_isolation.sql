-- =============================================================================
-- Teacher-note isolation proof - the FIRST write-path policies in this database
--
-- RUNS INSIDE A TRANSACTION AND ROLLS BACK. It creates two teachers, three
-- students, the attendance that puts one student on each teacher's roster, and
-- then signs in as each human in turn and WRITES. Nothing survives.
--
-- WHY IT WRITES RATHER THAN ASSERTING ON REAL ROWS. Every other policy in this
-- database is `for select`, and portal_auth_isolation.sql proves those. 0056 is
-- the first table an ordinary user may INSERT, UPDATE and DELETE, so the only
-- honest proof is to attempt each - as the author, as another teacher, as the
-- addressed student, as a different student, and signed out - and check which are
-- allowed. A test that only read would miss the entire point of the migration.
--
-- HOW THE USER IS FAKED. Same mechanism as portal_auth_isolation.sql: set
-- request.jwt.claims and `set local role authenticated`, which is exactly what
-- PostgREST does per request, so the policies run the way the portal runs them.
--
-- THE TWO KINDS, AND WHO MAY TOUCH EACH:
--   private - tina's own, no student. tina reads it; nobody else does.
--   public  - about a student tina taught. tina AND that student read it.
--   A teacher may only ADDRESS a public note to a student teaches_student() says
--   they taught - enforced on write. A student's read matches on student_id only.
--
-- THIS TEST CAN FAIL. To prove it is not passing by accident, drop a policy and
-- run it again. EXPECTED, not yet measured - if one does NOT go red, that is a
-- finding:
--
--     drop policy teacher_note_author_insert on app.teacher_note;  -- A1,A2 red
--     drop policy teacher_note_author_select on app.teacher_note;  -- B1 red
--     drop policy teacher_note_student_select on app.teacher_note; -- C1 red
--     drop policy teacher_note_author_update on app.teacher_note;  -- F1 red
--     drop policy teacher_note_author_delete on app.teacher_note;  -- F3 red
--
-- The INSERT roster rule (A3) and the cross-teacher refusals (E) rest on the
-- `with`/`using` clauses rather than on a whole policy, so the way to watch those
-- go red is to widen the clause, e.g. replace the insert `with check` body with
-- `(true)`.
--
-- Restore by re-running 0056 (safe to re-run). Requires 0053, 0055 and 0056. Run
-- as postgres / the SQL editor. Read the NOTICEs; any FAIL is real.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- The cast. tina and trevor both teach; alice attended tina's session, bob
-- attended trevor's, and carol attended neither - so carol is a real student tina
-- may NOT address a public note to, with a row to prove it rather than an absence.
-- -----------------------------------------------------------------------------
insert into app.student (id, first_name, last_name, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'alice', '__tn_test', '__tn_alice@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bob',   '__tn_test', '__tn_bob@test.invalid'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'carol', '__tn_test', '__tn_carol@test.invalid');

insert into app.teacher (id, first_name, last_name, email) values
  ('0e0e0e0e-0000-0000-0000-0000000000a1', 'tina',   '__tn_test', '__tn_tina@test.invalid'),
  ('0e0e0e0e-0000-0000-0000-0000000000b1', 'trevor', '__tn_test', '__tn_trevor@test.invalid');

-- Both teachers are signed in here, because section E needs trevor to actually
-- attempt a read of tina's note. Each identity carries teacher_id and no
-- student_id - identity_one_role_check forbids both, and the roster rests on it.
insert into app.identity (id, teacher_id, auth_user_id) values
  ('7e7e7e7e-0000-0000-0000-0000000000a1', '0e0e0e0e-0000-0000-0000-0000000000a1',
   'aaaa0000-0000-0000-0000-00000000000a'),
  ('7e7e7e7e-0000-0000-0000-0000000000b1', '0e0e0e0e-0000-0000-0000-0000000000b1',
   'bbbb0000-0000-0000-0000-00000000000b');

insert into app.identity (id, student_id, auth_user_id) values
  ('a1a1a1a1-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000a1',
   'aaaa1111-0000-0000-0000-00000000000a'),
  ('b1b1b1b1-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-0000000000b1',
   'bbbb1111-0000-0000-0000-00000000000b'),
  ('c1c1c1c1-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-0000000000c1',
   'cccc1111-0000-0000-0000-00000000000c');

insert into app.cohort (id, title) values
  ('c0c0c0c0-0000-0000-0000-0000000000a1', '__tn_tina_cohort'),
  ('c0c0c0c0-0000-0000-0000-0000000000b1', '__tn_trevor_cohort');

insert into app.class_session (id, cohort_id, title, starts_at) values
  ('5e551011-0000-0000-0000-0000000000a1', 'c0c0c0c0-0000-0000-0000-0000000000a1',
   '__tn_tina_session',   now() - interval '1 day'),
  ('5e551011-0000-0000-0000-0000000000b1', 'c0c0c0c0-0000-0000-0000-0000000000b1',
   '__tn_trevor_session', now() - interval '1 day');

insert into app.class_session_teacher (class_session_id, teacher_id) values
  ('5e551011-0000-0000-0000-0000000000a1', '0e0e0e0e-0000-0000-0000-0000000000a1'),
  ('5e551011-0000-0000-0000-0000000000b1', '0e0e0e0e-0000-0000-0000-0000000000b1');

-- alice on tina's roster, bob on trevor's. carol attended nothing.
insert into app.attendance_record (class_session_id, student_id, is_attended) values
  ('5e551011-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('5e551011-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-0000000000b1', true);

do $$
declare
  tina_auth   uuid := 'aaaa0000-0000-0000-0000-00000000000a';
  trevor_auth uuid := 'bbbb0000-0000-0000-0000-00000000000b';
  alice_auth  uuid := 'aaaa1111-0000-0000-0000-00000000000a';
  bob_auth    uuid := 'bbbb1111-0000-0000-0000-00000000000b';
  alice_id    uuid := 'aaaaaaaa-0000-0000-0000-0000000000a1';
  bob_id      uuid := 'bbbbbbbb-0000-0000-0000-0000000000b1';
  carol_id    uuid := 'cccccccc-0000-0000-0000-0000000000c1';
  tina_id     uuid := '0e0e0e0e-0000-0000-0000-0000000000a1';
  trevor_id   uuid := '0e0e0e0e-0000-0000-0000-0000000000b1';
  private_id  uuid;
  public_id   uuid;
  n           int;
  v_vis       text;
  failures    int := 0;
  fails       text[] := '{}';
begin
  -- ===========================================================================
  -- A. tina writes - a private note, a public note to alice, and a refused one
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', tina_auth, 'email', '__tn_tina@test.invalid')::text, true);
  set local role authenticated;

  -- A1: a private (personal) note. No student, so no roster check applies.
  begin
    insert into app.teacher_note (author_teacher_id, visibility, body)
    values (tina_id, 'private', '__tn tina private')
    returning id into private_id;
    raise notice 'PASS  A1  tina writes a private note';
  exception when others then
    failures := failures + 1;
    fails := fails || format('FAIL A1 tina''s private insert raised %s', sqlerrm);
    raise notice '%', fails[cardinality(fails)];
  end;

  -- A2: a public note to alice, who is on tina's roster.
  begin
    insert into app.teacher_note (author_teacher_id, student_id, visibility, body)
    values (tina_id, alice_id, 'public', '__tn tina to alice')
    returning id into public_id;
    raise notice 'PASS  A2  tina writes a public note to a student she taught';
  exception when others then
    failures := failures + 1;
    fails := fails || format('FAIL A2 tina''s public insert for alice raised %s', sqlerrm);
    raise notice '%', fails[cardinality(fails)];
  end;

  -- A3: a public note to carol, whom tina never taught. The roster rule is in the
  -- INSERT `with check`, so RLS must refuse this (42501), not the kind check.
  begin
    insert into app.teacher_note (author_teacher_id, student_id, visibility, body)
    values (tina_id, carol_id, 'public', '__tn tina to carol');
    failures := failures + 1;
    fails := fails || 'FAIL A3 tina addressed a public note to a student she never taught';
    raise notice '%', fails[cardinality(fails)];
  exception
    when insufficient_privilege then
      raise notice 'PASS  A3  tina cannot address a public note to a student off her roster';
    when others then
      failures := failures + 1;
      fails := fails || format('FAIL A3 refused with the wrong error: %s', sqlerrm);
      raise notice '%', fails[cardinality(fails)];
  end;

  -- A4: she cannot forge authorship - a note claiming trevor as author.
  begin
    insert into app.teacher_note (author_teacher_id, visibility, body)
    values (trevor_id, 'private', '__tn forged');
    failures := failures + 1;
    fails := fails || 'FAIL A4 tina wrote a note authored by trevor';
    raise notice '%', fails[cardinality(fails)];
  exception
    when insufficient_privilege then
      raise notice 'PASS  A4  tina cannot write a note as another teacher';
    when others then
      failures := failures + 1;
      fails := fails || format('FAIL A4 refused with the wrong error: %s', sqlerrm);
      raise notice '%', fails[cardinality(fails)];
  end;

  -- ===========================================================================
  -- B. tina reads her own - both kinds
  -- ===========================================================================
  select count(*) into n from app.teacher_note where body like '\_\_tn %';
  if n = 2 then
    raise notice 'PASS  B1  tina sees her 2 notes (private and public)';
  else
    failures := failures + 1;
    fails := fails || format('FAIL B1 tina sees %s of her notes, expected 2', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ===========================================================================
  -- C. alice - the addressed student - reads the public note, not the private one
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice_auth, 'email', '__tn_alice@test.invalid')::text, true);
  set local role authenticated;

  select count(*), coalesce(string_agg(visibility, ','), '(none)')
    into n, v_vis
    from app.teacher_note where body like '\_\_tn %';

  if n = 1 and v_vis = 'public' then
    raise notice 'PASS  C1  alice sees exactly the public note addressed to her';
  else
    failures := failures + 1;
    fails := fails || format('FAIL C1 alice sees %s notes (%s), expected 1 public', n, v_vis);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- She cannot edit or delete a note she can read - the write policies are author
  -- only. `found` is false when RLS matched no row for the UPDATE.
  begin
    update app.teacher_note set body = '__tn alice tampered' where id = public_id;
    if found then
      failures := failures + 1;
      fails := fails || 'FAIL C2 alice edited a teacher''s note';
      raise notice '%', fails[cardinality(fails)];
    else
      raise notice 'PASS  C2  alice''s edit of the note matched no row';
    end if;
  exception when insufficient_privilege then
    raise notice 'PASS  C2  alice''s edit was refused';
  end;

  reset role;

  -- ===========================================================================
  -- D. bob - a different student - sees none of tina's notes
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob_auth, 'email', '__tn_bob@test.invalid')::text, true);
  set local role authenticated;

  select count(*) into n from app.teacher_note where body like '\_\_tn %';
  if n = 0 then
    raise notice 'PASS  D1  bob sees none of tina''s notes - public one is not his';
  else
    failures := failures + 1;
    fails := fails || format('FAIL D1 bob sees %s notes, expected 0', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ===========================================================================
  -- E. trevor - another teacher - cannot read, edit or delete tina's notes
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', trevor_auth, 'email', '__tn_trevor@test.invalid')::text, true);
  set local role authenticated;

  select count(*) into n from app.teacher_note where body like '\_\_tn %';
  if n = 0 then
    raise notice 'PASS  E1  trevor sees none of tina''s notes';
  else
    failures := failures + 1;
    fails := fails || format('FAIL E1 trevor sees %s of tina''s notes, expected 0', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  begin
    update app.teacher_note set body = '__tn trevor tampered' where id = private_id;
    if found then
      failures := failures + 1;
      fails := fails || 'FAIL E2 trevor edited tina''s note';
      raise notice '%', fails[cardinality(fails)];
    else
      raise notice 'PASS  E2  trevor''s edit of tina''s note matched no row';
    end if;
  exception when insufficient_privilege then
    raise notice 'PASS  E2  trevor''s edit was refused';
  end;

  begin
    delete from app.teacher_note where id = public_id;
    if found then
      failures := failures + 1;
      fails := fails || 'FAIL E3 trevor deleted tina''s note';
      raise notice '%', fails[cardinality(fails)];
    else
      raise notice 'PASS  E3  trevor''s delete of tina''s note matched no row';
    end if;
  exception when insufficient_privilege then
    raise notice 'PASS  E3  trevor''s delete was refused';
  end;

  reset role;

  -- ===========================================================================
  -- F. tina edits and deletes her own, and cannot move a note off her roster
  -- ===========================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', tina_auth, 'email', '__tn_tina@test.invalid')::text, true);
  set local role authenticated;

  update app.teacher_note set body = '__tn tina edited' where id = private_id;
  if found then
    raise notice 'PASS  F1  tina edits her own note';
  else
    failures := failures + 1;
    fails := fails || 'FAIL F1 tina could not edit her own note';
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- F2: she cannot re-point her public note at carol, whom she never taught. The
  -- UPDATE `with check` re-runs the roster rule.
  begin
    update app.teacher_note set student_id = carol_id where id = public_id;
    failures := failures + 1;
    fails := fails || 'FAIL F2 tina moved a public note onto a student off her roster';
    raise notice '%', fails[cardinality(fails)];
  exception
    when insufficient_privilege then
      raise notice 'PASS  F2  tina cannot move a public note onto a student off her roster';
    when others then
      failures := failures + 1;
      fails := fails || format('FAIL F2 refused with the wrong error: %s', sqlerrm);
      raise notice '%', fails[cardinality(fails)];
  end;

  delete from app.teacher_note where id = public_id;
  if found then
    raise notice 'PASS  F3  tina deletes her own note';
  else
    failures := failures + 1;
    fails := fails || 'FAIL F3 tina could not delete her own note';
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ===========================================================================
  -- G. Signed out - 0053 revoked anon on schema app, so this is a refusal, not a
  -- filtered-to-zero read. The same shape as portal_auth_isolation.sql section D.
  -- ===========================================================================
  perform set_config('request.jwt.claims', NULL, true);

  begin
    set local role anon;
    select count(*) into n from app.teacher_note where body like '\_\_tn %';
    failures := failures + 1;
    fails := fails || format('FAIL G1 anon reached app.teacher_note and saw %s rows', n);
    raise notice '%', fails[cardinality(fails)];
  exception when insufficient_privilege then
    raise notice 'PASS  G1  anon is refused by grant, not merely filtered by policy';
  end;

  reset role;

  -- ===========================================================================
  if failures = 0 then
    raise notice '---- ALL PASSED: a note is written, read and removed only by the people it belongs to ----';
  else
    raise exception E'% teacher-note check(s) FAILED:\n%',
      failures, array_to_string(fails, E'\n');
  end if;
end
$$;

-- Nothing is kept.
rollback;

-- Belt and braces: prove the test data is gone. Expect ZERO rows. The underscores
-- are escaped - `_` is LIKE's single-character wildcard (the lesson from
-- portal_auth_isolation.sql).
select id, body from app.teacher_note where body like '\_\_tn %';
