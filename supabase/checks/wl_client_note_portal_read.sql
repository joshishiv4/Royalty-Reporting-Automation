-- =============================================================================
-- WellnessLiving note -> teacher_note proof (0067) - the sync's notes arrive as
-- linked teacher_note rows, the right people read them, nobody edits them
--
-- RUNS INSIDE A TRANSACTION AND ROLLS BACK. Nothing survives.
--
-- (This file proved 0065's two functions until 0067 dropped them. Same cast, same
-- name, so the history of "who may read a WL note" stays in one place.)
--
-- THE CAST. alice and bob are WellnessLiving clients of a student login type;
-- tina is a client of a teacher login type. 0040's person trigger gives each
-- their identity and role, exactly as the sync does. tina taught alice's session,
-- not bob's. Each of the three has a WL note, inserted into wl_client_note the
-- way the sync writes it - so 0067's trigger, not this script, makes the
-- teacher_note rows.
--
-- WHY EVERY "SEES NOTHING" IS PAIRED WITH A "SEES SOMETHING". A policy that
-- returns zero rows for everybody passes every isolation line for the wrong
-- reason. L1-L3 prove the notes exist, and T1/S1 that the right reader gets
-- them, before the other lines prove everyone else does not.
--
-- HOW THE USER IS FAKED. request.jwt.claims + `set local role authenticated`, as
-- in teacher_note_isolation.sql.
--
-- THIS TEST CAN FAIL. Expected, not yet measured - if one does NOT go red, that
-- is a finding:
--
--   * teacher_note_wl_student_select without `app.teaches_student(student_id)`
--                                                      -> T1 red (tina sees bob)
--   * teacher_note_author_update without `not app.is_linked_note(id)`
--     (re-run 0063)                                    -> T4 red
--   * record_teacher_note_revision without the link guard (re-run 0057)
--                                                      -> Y1 red (not-null error)
--   * the wl_client_note_to_teacher_note trigger dropped -> L1 red
--   * drop trigger teacher_note_author_or_link         -> N1 red
--   * teacher_note_link keyed by uid alone (0067)      -> M1 red
--   * grant select on app.teacher_note_link to authenticated
--                                                      -> K1 red
--
-- Restore by re-running 0067 then 0068. Requires 0040, 0053, 0055, 0058, 0063, 0064, 0068 and
-- 0067. Run as postgres / the SQL editor.
-- =============================================================================

begin;

insert into public.login_type (k_login_type, k_business, title, is_teacher_type) values
  ('__wcp_type',  '__wcp_biz', '__wcp student type', false),
  ('__wcp_tteach', '__wcp_biz', '__wcp teacher type', true);

insert into public.person (uid, k_business, first_name, last_name, k_login_type, ghl_match_state)
values
  ('__wcp_alice', '__wcp_biz', 'alice', '__wcp_test', '__wcp_type',   'unmatched'),
  ('__wcp_bob',   '__wcp_biz', 'bob',   '__wcp_test', '__wcp_type',   'unmatched'),
  ('__wcp_tina',  '__wcp_biz', 'tina',  '__wcp_test', '__wcp_tteach', 'unmatched');

update app.identity set auth_user_id = 'aaaa1111-0000-0000-0000-0000000000c1' where uid = '__wcp_alice';
update app.identity set auth_user_id = 'bbbb1111-0000-0000-0000-0000000000c1' where uid = '__wcp_bob';
update app.identity set auth_user_id = 'aaaa0000-0000-0000-0000-0000000000c1' where uid = '__wcp_tina';

insert into app.cohort (id, title) values
  ('c0c0c0c0-0000-0000-0000-0000000000c1', '__wcp_cohort');
insert into app.class_session (id, cohort_id, title, starts_at) values
  ('5e551011-0000-0000-0000-0000000000c1', 'c0c0c0c0-0000-0000-0000-0000000000c1',
   '__wcp_session', now() - interval '1 day');
insert into app.class_session_teacher (class_session_id, teacher_id)
select '5e551011-0000-0000-0000-0000000000c1', i.teacher_id
  from app.identity i where i.uid = '__wcp_tina';

-- alice on tina's roster. bob attended nothing of tina's.
insert into app.attendance_record (class_session_id, student_id, is_attended)
select '5e551011-0000-0000-0000-0000000000c1', i.student_id, true
  from app.identity i where i.uid = '__wcp_alice';

-- As the sync writes them. 0067's trigger turns each into a teacher_note.
insert into public.wl_client_note (uid, k_business, note_key, position, note_html, note_text, synced_at)
values
  ('__wcp_alice', '__wcp_biz', 'ka', 0, '<p>alice discount</p>', 'alice discount', now()),
  ('__wcp_bob',   '__wcp_biz', 'kb', 0, '<p>bob discount</p>',   'bob discount',   now()),
  ('__wcp_tina',  '__wcp_biz', 'kt', 0, '<p>tina rate</p>',      'tina rate',      now());

do $$
declare
  tina_auth  uuid := 'aaaa0000-0000-0000-0000-0000000000c1';
  alice_auth uuid := 'aaaa1111-0000-0000-0000-0000000000c1';
  bob_auth   uuid := 'bbbb1111-0000-0000-0000-0000000000c1';
  alice_student uuid;
  tina_teacher  uuid;
  alice_note    uuid;
  bob_note      uuid;
  tina_note     uuid;
  n          int;
  got        text;
  ok         boolean;
  failures   int := 0;
  fails      text[] := '{}';
begin
  -- Precondition: the trigger really made two students and a teacher.
  select count(*) into n from app.identity
   where uid in ('__wcp_alice', '__wcp_bob') and student_id is not null;
  if n <> 2 then
    raise exception 'precondition: expected 2 student identities, found %', n;
  end if;
  select teacher_id into tina_teacher from app.identity where uid = '__wcp_tina';
  if tina_teacher is null then
    raise exception 'precondition: tina has no teacher identity';
  end if;
  select student_id into alice_student from app.identity where uid = '__wcp_alice';

  select teacher_note_id into alice_note from app.teacher_note_link where uid = '__wcp_alice';
  select teacher_note_id into bob_note   from app.teacher_note_link where uid = '__wcp_bob';
  select teacher_note_id into tina_note  from app.teacher_note_link where uid = '__wcp_tina';

  -- ===========================================================================
  -- L. the trigger made the notes
  -- ===========================================================================
  select count(*) into n from app.teacher_note t
   where t.id = alice_note and t.visibility = 'public' and t.student_id = alice_student
     and t.author_teacher_id is null and t.body = 'alice discount' and t.deleted_at is null;
  if n = 1 then
    raise notice 'PASS  L1 alice''s WL note is a public, authorless note to alice';
  else
    failures := failures + 1;
    fails := fails || 'FAIL L1 alice''s WL note did not arrive as a linked public note';
    raise notice '%', fails[cardinality(fails)];
  end if;

  select count(*) into n from app.teacher_note t
   where t.id = tina_note and t.visibility = 'private' and t.student_id is null
     and t.author_teacher_id = tina_teacher and t.body = 'tina rate';
  if n = 1 then
    raise notice 'PASS  L2 tina''s WL note is her own private note';
  else
    failures := failures + 1;
    fails := fails || 'FAIL L2 tina''s WL note did not arrive as her private note';
    raise notice '%', fails[cardinality(fails)];
  end if;

  select count(*) into n from app.teacher_note_link where uid like '\_\_wcp\_%';
  if n = 3 and bob_note is not null then
    raise notice 'PASS  L3 one link per WL note';
  else
    failures := failures + 1;
    fails := fails || format('FAIL L3 %s link(s) for 3 WL notes', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- ===========================================================================
  -- T. tina, a teacher
  -- ===========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', tina_auth)::text, true);
  set local role authenticated;

  select count(*), string_agg(body, ', ' order by body) into n, got
    from app.teacher_note where body like '% discount';
  if n = 1 and got = 'alice discount' then
    raise notice 'PASS  T1 tina sees alice''s WL note and not bob''s';
  else
    failures := failures + 1;
    fails := fails || format('FAIL T1 tina sees %s WL student note(s): %s', n, coalesce(got, '(none)'));
    raise notice '%', fails[cardinality(fails)];
  end if;

  select count(*) into n from app.teacher_note where id = tina_note;
  if n = 1 then
    raise notice 'PASS  T2 tina sees her own WL note';
  else
    failures := failures + 1;
    fails := fails || 'FAIL T2 tina cannot see her own WL note';
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- The portal can tell which notes came from WL: the note id, never the uid.
  select count(*) into n from app.teacher_note_link where teacher_note_id in (alice_note, tina_note);
  if n = 2 then
    raise notice 'PASS  T3 tina can see which of her visible notes are linked';
  else
    failures := failures + 1;
    fails := fails || format('FAIL T3 tina sees %s link row(s), expected 2', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  update app.teacher_note set body = 'edited' where id in (alice_note, tina_note);
  get diagnostics n = row_count;
  if n = 0 then
    raise notice 'PASS  T4 tina can edit neither alice''s WL note nor her own';
  else
    failures := failures + 1;
    fails := fails || format('FAIL T4 tina edited %s WL note(s)', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- K. the link's uid is not readable through the API.
  begin
    perform uid from app.teacher_note_link limit 1;
    ok := false;
  exception when insufficient_privilege then
    ok := true;
  end;
  if ok then
    raise notice 'PASS  K1 the link''s WL uid is not readable';
  else
    failures := failures + 1;
    fails := fails || 'FAIL K1 authenticated read teacher_note_link.uid';
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ===========================================================================
  -- S. alice and bob, students
  -- ===========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', alice_auth)::text, true);
  set local role authenticated;

  select count(*), string_agg(body, ', ') into n, got
    from app.teacher_note where id in (alice_note, bob_note, tina_note);
  if n = 1 and got = 'alice discount' then
    raise notice 'PASS  S1 alice sees her own WL note, not bob''s or tina''s';
  else
    failures := failures + 1;
    fails := fails || format('FAIL S1 alice sees %s note(s): %s', n, coalesce(got, '(none)'));
    raise notice '%', fails[cardinality(fails)];
  end if;

  update app.teacher_note set body = 'edited' where id = alice_note;
  get diagnostics n = row_count;
  if n = 0 then
    raise notice 'PASS  S2 alice cannot edit her WL note';
  else
    failures := failures + 1;
    fails := fails || 'FAIL S2 alice edited her WL note';
    raise notice '%', fails[cardinality(fails)];
  end if;

  select count(*) into n from public.wl_client_note where uid like '\_\_wcp\_%';
  if n = 0 then
    raise notice 'PASS  S4 alice reads no row of wl_client_note directly';
  else
    failures := failures + 1;
    fails := fails || format('FAIL S4 alice reads %s wl_client_note row(s) directly', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', bob_auth)::text, true);
  set local role authenticated;
  select count(*), string_agg(body, ', ') into n, got
    from app.teacher_note where id in (alice_note, bob_note, tina_note);
  if n = 1 and got = 'bob discount' then
    raise notice 'PASS  S3 bob sees his own WL note only';
  else
    failures := failures + 1;
    fails := fails || format('FAIL S3 bob sees %s note(s): %s', n, coalesce(got, '(none)'));
    raise notice '%', fails[cardinality(fails)];
  end if;
  reset role;

  -- ===========================================================================
  -- A. anon
  -- ===========================================================================
  perform set_config('request.jwt.claims', NULL, true);
  set local role anon;
  begin
    select count(*) into n from app.teacher_note where id in (alice_note, bob_note, tina_note);
    ok := (n = 0);
  exception when insufficient_privilege then
    ok := true;
  end;
  reset role;
  if ok then
    raise notice 'PASS  A1 anon reads no WL note';
  else
    failures := failures + 1;
    fails := fails || format('FAIL A1 anon read %s WL note(s)', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- ===========================================================================
  -- Y. the sync's next pass: edit, remove, bring back
  -- ===========================================================================
  update public.wl_client_note
     set note_text = 'alice discount, raised', note_html = '<p>alice discount, raised</p>'
   where uid = '__wcp_alice';
  select count(*) into n from app.teacher_note
   where id = alice_note and body = 'alice discount, raised';
  if n = 1 and not exists (select 1 from app.teacher_note_revision where note_id = alice_note) then
    raise notice 'PASS  Y1 an edit in WL updates the note, with no revision row';
  else
    failures := failures + 1;
    fails := fails || 'FAIL Y1 an edited WL note did not update cleanly';
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- The nightly re-sync of an unchanged note writes nothing. now() is fixed for
  -- the transaction, so a timestamp cannot tell; the row version (xmin) can.
  select xmin::text into got from app.teacher_note where id = tina_note;
  update public.wl_client_note set synced_at = now() + interval '1 day' where uid = '__wcp_tina';
  select count(*) into n from app.teacher_note where id = tina_note and xmin::text = got;
  if n = 1 then
    raise notice 'PASS  Y2 an unchanged re-sync leaves the note alone';
  else
    failures := failures + 1;
    fails := fails || 'FAIL Y2 an unchanged re-sync rewrote the note';
    raise notice '%', fails[cardinality(fails)];
  end if;

  delete from public.wl_client_note where uid = '__wcp_bob';
  select count(*) into n from app.teacher_note where id = bob_note and deleted_at is not null;
  if n = 1 then
    raise notice 'PASS  Y3 a note removed in WL is soft-deleted';
  else
    failures := failures + 1;
    fails := fails || 'FAIL Y3 a removed WL note was not soft-deleted';
    raise notice '%', fails[cardinality(fails)];
  end if;

  insert into public.wl_client_note (uid, k_business, note_key, position, note_html, note_text, synced_at)
  values ('__wcp_bob', '__wcp_biz', 'kb', 0, '<p>bob back</p>', 'bob back', now());
  select count(*) into n from app.teacher_note
   where id = bob_note and deleted_at is null and body = 'bob back';
  if n = 1 then
    raise notice 'PASS  Y4 a note that comes back reuses its link';
  else
    failures := failures + 1;
    fails := fails || 'FAIL Y4 a returning WL note did not reuse its link';
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- ===========================================================================
  -- M. several notes on one profile are several notes (0068)
  -- ===========================================================================
  -- WL put a second note above alice's: a new key, position 0; hers moves to 1.
  update public.wl_client_note set position = 1 where uid = '__wcp_alice' and note_key = 'ka';
  insert into public.wl_client_note (uid, k_business, note_key, position, note_html, note_text, synced_at)
  values ('__wcp_alice', '__wcp_biz', 'ka2', 0, '<p>alice second</p>', 'alice second', now());
  select count(*) into n
    from app.teacher_note_link l join app.teacher_note t on t.id = l.teacher_note_id
   where l.uid = '__wcp_alice' and t.deleted_at is null and t.student_id = alice_student;
  if n = 2 and exists (select 1 from app.teacher_note_link
                        where teacher_note_id = alice_note and position = 1) then
    raise notice 'PASS  M1 a second WL note is a second note, and the first keeps its link';
  else
    failures := failures + 1;
    fails := fails || format('FAIL M1 alice has %s live WL note(s), expected 2 with hers at position 1', n);
    raise notice '%', fails[cardinality(fails)];
  end if;

  -- ===========================================================================
  -- N. a note with no author and no link is refused, even as the owner
  -- ===========================================================================
  set constraints all immediate;
  begin
    insert into app.teacher_note (author_teacher_id, student_id, visibility, body)
    values (null, alice_student, 'public', '__wcp orphan');
    ok := false;
  exception when not_null_violation then
    ok := true;
  end;
  set constraints all deferred;
  if ok then
    raise notice 'PASS  N1 a note with no author and no link is refused';
  else
    failures := failures + 1;
    fails := fails || 'FAIL N1 a note with no author and no link was accepted';
    raise notice '%', fails[cardinality(fails)];
  end if;

  if failures = 0 then
    raise notice '---- ALL PASSED: WL notes arrive as linked teacher_note rows, read by the right people only ----';
  else
    raise exception E'% WL-note check(s) FAILED:\n%', failures, array_to_string(fails, E'\n');
  end if;
end
$$;

rollback;

-- Prove the test data is gone. Expect ZERO rows.
select uid from public.person where uid like '\_\_wcp\_%';
