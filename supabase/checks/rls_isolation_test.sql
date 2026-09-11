-- =============================================================================
-- RLS isolation proof - one user cannot read another user's rows
--
-- This RUNS INSIDE A TRANSACTION AND ROLLS BACK. It inserts two test people,
-- proves each sees only their own row, and undoes everything. Nothing survives.
--
-- WHY IT INSERTS RATHER THAN ASSERTING ON REAL DATA. A policy that returns zero
-- rows passes "cannot see another user's data" for the wrong reason - it also
-- returns zero for your own. Proving isolation needs at least two rows with two
-- owners, and the tables are empty. So the test makes them.
--
-- HOW THE USER IS FAKED. Supabase's auth.uid() reads the `sub` claim from
-- request.jwt.claims. Setting that GUC and switching to the `authenticated` role
-- is exactly what the API does per request, so the policies are exercised the
-- same way the portal will exercise them.
--
-- Requires 0010 for the policies and person.auth_user_id.
-- Run as postgres / the SQL editor. Read the four NOTICEs; any FAIL is real.
-- =============================================================================

begin;

-- Two people, two owners. Inlined as VALUES rather than staged in a temp table:
-- the Supabase SQL editor commits between statements, so an `on commit drop` temp
-- table was gone before the next statement could read it (ERROR 42P01). No temp
-- table means no such dependency.
insert into public.person (uid, k_business, auth_user_id, first_name, ghl_match_state)
values
  ('__rls_test_alice', '__rls_test_biz', '11111111-1111-1111-1111-111111111111', 'alice', 'unmatched'),
  ('__rls_test_bob',   '__rls_test_biz', '22222222-2222-2222-2222-222222222222', 'bob',   'unmatched');

-- One purchase each, so the joined policies are exercised too and not just the
-- simple one on person.
insert into public.purchase (k_purchase, k_business, uid_payer, uid_recipient, m_total)
values ('__rls_test_p_alice', '__rls_test_biz', '__rls_test_alice', '__rls_test_alice', 100.00),
       ('__rls_test_p_bob',   '__rls_test_biz', '__rls_test_bob',   '__rls_test_bob',   200.00);

do $$
declare
  alice uuid := '11111111-1111-1111-1111-111111111111';
  bob   uuid := '22222222-2222-2222-2222-222222222222';
  n_person   int;
  n_purchase int;
  who        text;
  failures   int := 0;
begin
  -- ---------------------------------------------------------------------------
  -- Acting as Alice
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);
  set local role authenticated;

  select count(*) into n_person   from public.person   where uid like '__rls_test_%';
  select count(*) into n_purchase from public.purchase where k_purchase like '__rls_test_%';
  select coalesce(string_agg(first_name, ','), '(none)') into who
    from public.person where uid like '__rls_test_%';

  if n_person = 1 and who = 'alice' then
    raise notice 'PASS  alice sees 1 person, and it is alice';
  else
    failures := failures + 1;
    raise notice 'FAIL  alice sees % person rows (%), expected exactly 1 (alice)', n_person, who;
  end if;

  if n_purchase = 1 then
    raise notice 'PASS  alice sees 1 purchase, not bob''s';
  else
    failures := failures + 1;
    raise notice 'FAIL  alice sees % purchases, expected 1', n_purchase;
  end if;

  reset role;

  -- ---------------------------------------------------------------------------
  -- Acting as Bob - the mirror, so a policy that happens to hardcode one user
  -- cannot pass by accident.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);
  set local role authenticated;

  select coalesce(string_agg(first_name, ','), '(none)') into who
    from public.person where uid like '__rls_test_%';

  if who = 'bob' then
    raise notice 'PASS  bob sees only bob';
  else
    failures := failures + 1;
    raise notice 'FAIL  bob sees %, expected bob', who;
  end if;

  reset role;

  -- ---------------------------------------------------------------------------
  -- Acting as anon - no claim at all. Should see nothing.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', NULL, true);
  set local role anon;

  select count(*) into n_person from public.person where uid like '__rls_test_%';

  if n_person = 0 then
    raise notice 'PASS  anon sees 0 person rows';
  else
    failures := failures + 1;
    raise notice 'FAIL  anon sees % person rows, expected 0', n_person;
  end if;

  reset role;

  if failures = 0 then
    raise notice '---- ALL PASSED: a user reads their own rows and nobody else''s ----';
  else
    raise exception '% RLS isolation check(s) FAILED - see the notices above', failures;
  end if;
end
$$;

-- Nothing is kept. The two people, their purchases and the temp table all go.
rollback;

-- Belt and braces: prove the test data really is gone. Expect ZERO rows.
select uid, first_name from public.person where uid like '__rls_test_%';
