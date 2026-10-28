-- =============================================================================
-- wl_client_note isolation proof - a client reads their own person row, and
-- NOT the studio's note about them
--
-- RUNS INSIDE A TRANSACTION AND ROLLS BACK. It inserts two test people with a
-- note each, signs in as one of them, and undoes everything.
--
-- WHY THE PERSON ROW IS COUNTED TOO. "Alice sees 0 notes" alone would also pass
-- if Alice could not sign in at all - zero for the wrong reason. So the same
-- session first proves Alice DOES read her own person row (person_self_select,
-- 0053), and only then that the note about her is invisible. That pairing is the
-- exact situation 0064 exists for: the person row is hers to read, the note on
-- it is not.
--
-- HOW THE USER IS FAKED. As in rls_isolation_test.sql: request.jwt.claims plus
-- `set local role authenticated`, which is what PostgREST does per request. The
-- person insert fires 0040's person_identity_insert, which creates the identity
-- the update below links to an auth user.
--
-- THIS TEST CAN FAIL. EXPECTED, not yet measured - if one of these does NOT go
-- red, that is a finding:
--
--     create policy x on public.wl_client_note
--       for select to authenticated using (true);         -- N2 red
--     grant select on public.wl_client_note to anon;
--     create policy y on public.wl_client_note
--       for select to anon using (true);                  -- N3 red
--     drop policy person_self_select on public.person;    -- N1 red
--
-- Restore by dropping the added policy (0064 itself refuses to run while one
-- exists) or re-running 0053 for person_self_select.
--
-- Requires 0053 and 0064. Run as postgres / the SQL editor. Any FAIL is raised
-- as an exception naming every failed line.
-- =============================================================================

begin;

insert into public.person (uid, k_business, first_name, ghl_match_state)
values
  ('__wcn_test_alice', '__wcn_test_biz', 'alice', 'unmatched'),
  ('__wcn_test_bob',   '__wcn_test_biz', 'bob',   'unmatched');

update app.identity set auth_user_id = '11111111-1111-1111-1111-111111111111'
 where uid = '__wcn_test_alice';

insert into public.wl_client_note (uid, k_business, note_html, note_text, synced_at)
values
  ('__wcn_test_alice', '__wcn_test_biz', '<p>alice discount</p>', 'alice discount', now()),
  ('__wcn_test_bob',   '__wcn_test_biz', '<p>bob discount</p>',   'bob discount',   now());

do $$
declare
  alice    uuid := '11111111-1111-1111-1111-111111111111';
  n_person int;
  n_note   int;
  failures int := 0;
  fails    text[] := '{}';
begin
  -- Acting as Alice.
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);
  set local role authenticated;

  select count(*) into n_person from public.person where uid like '\_\_wcn\_test\_%';
  select count(*) into n_note from public.wl_client_note where uid like '\_\_wcn\_test\_%';

  if n_person = 1 then
    raise notice 'PASS  N1 alice reads her own person row';
  else
    failures := failures + 1;
    fails := fails || format('FAIL N1 alice sees %s person rows, expected 1 - '
                             'without this, N2 passes for the wrong reason', n_person);
    raise notice '%', fails[cardinality(fails)];
  end if;

  if n_note = 0 then
    raise notice 'PASS  N2 alice reads no note - not even the one about her';
  else
    failures := failures + 1;
    fails := fails || format('FAIL N2 alice sees %s wl_client_note rows, expected 0', n_note);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- Acting as anon.
  perform set_config('request.jwt.claims', NULL, true);
  set local role anon;

  begin
    select count(*) into n_note from public.wl_client_note where uid like '\_\_wcn\_test\_%';
  exception when insufficient_privilege then
    n_note := 0;  -- no grant at all is also a correct answer
  end;

  if n_note = 0 then
    raise notice 'PASS  N3 anon reads no note';
  else
    failures := failures + 1;
    fails := fails || format('FAIL N3 anon sees %s wl_client_note rows, expected 0', n_note);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  if failures = 0 then
    raise notice '---- ALL PASSED: the studio''s notes are invisible to the client they describe ----';
  else
    raise exception E'% wl_client_note isolation check(s) FAILED:\n%',
      failures, array_to_string(fails, E'\n');
  end if;
end
$$;

rollback;

-- Prove the test data is gone. Expect ZERO rows.
select uid from public.person where uid like '\_\_wcn\_test\_%';
