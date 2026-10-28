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
-- WHICH ANCHOR THIS USES. `0053` dropped `person.auth_user_id` and re-pointed
-- these five policies through `identity`, so the link is now made on the hub
-- rather than on the person row. The proof is unchanged in every other respect -
-- same two people, same assertions - because what is being proved did not change.
--
-- The portal's own tables in `app` are proved separately, by
-- portal_auth_isolation.sql. Two files because they are two different claims:
-- this one says a student cannot read another student's WELLNESSLIVING rows.
--
-- Requires 0053 for the policies and the helpers.
-- Run as postgres / the SQL editor. Read the four NOTICEs; any FAIL is real.
-- =============================================================================

begin;

-- Two people, two owners. Inlined as VALUES rather than staged in a temp table:
-- the Supabase SQL editor commits between statements, so an `on commit drop` temp
-- table was gone before the next statement could read it (ERROR 42P01). No temp
-- table means no such dependency.
insert into public.person (uid, k_business, first_name, ghl_match_state)
values
  ('__rls_test_alice', '__rls_test_biz', 'alice', 'unmatched'),
  ('__rls_test_bob',   '__rls_test_biz', 'bob',   'unmatched');

-- The link, which since 0053 lives on the hub rather than on the person row.
--
-- No identity is inserted here, and that is not an omission: the insert above
-- fires 0040's `person_identity_insert`, which creates the identity and the
-- student role. So this update also quietly proves that trigger still runs - if
-- it ever stops, these two statements update zero rows and every assertion below
-- fails rather than passing against a person nobody can resolve.
update app.identity set auth_user_id = '11111111-1111-1111-1111-111111111111'
 where uid = '__rls_test_alice';
update app.identity set auth_user_id = '22222222-2222-2222-2222-222222222222'
 where uid = '__rls_test_bob';

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
  fails      text[] := '{}';
begin
  -- ---------------------------------------------------------------------------
  -- Acting as Alice
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);
  set local role authenticated;

  select count(*) into n_person   from public.person   where uid like '\_\_rls\_test\_%';
  select count(*) into n_purchase from public.purchase where k_purchase like '\_\_rls\_test\_%';
  select coalesce(string_agg(first_name, ','), '(none)') into who
    from public.person where uid like '\_\_rls\_test\_%';

  if n_person = 1 and who = 'alice' then
    raise notice 'PASS  alice sees 1 person, and it is alice';
  else
    failures := failures + 1;
    fails := fails || format('FAIL alice sees %s person rows (%s), expected exactly 1 (alice)', n_person, who);
    raise notice '%', fails[cardinality(fails)];
  end if;

  if n_purchase = 1 then
    raise notice 'PASS  alice sees 1 purchase, not bob''s';
  else
    failures := failures + 1;
    fails := fails || format('FAIL alice sees %s purchases, expected 1', n_purchase);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ---------------------------------------------------------------------------
  -- Acting as Bob - the mirror, so a policy that happens to hardcode one user
  -- cannot pass by accident.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);
  set local role authenticated;

  select coalesce(string_agg(first_name, ','), '(none)') into who
    from public.person where uid like '\_\_rls\_test\_%';

  if who = 'bob' then
    raise notice 'PASS  bob sees only bob';
  else
    failures := failures + 1;
    fails := fails || format('FAIL bob sees %s, expected bob', who);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  -- ---------------------------------------------------------------------------
  -- Acting as anon - no claim at all. Should see nothing.
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', NULL, true);
  set local role anon;

  select count(*) into n_person from public.person where uid like '\_\_rls\_test\_%';

  if n_person = 0 then
    raise notice 'PASS  anon sees 0 person rows';
  else
    failures := failures + 1;
    fails := fails || format('FAIL anon sees %s person rows, expected 0', n_person);
    raise notice '%', fails[cardinality(fails)];
  end if;

  reset role;

  if failures = 0 then
    raise notice '---- ALL PASSED: a user reads their own rows and nobody else''s ----';
  else
    -- The failed lines go in the EXCEPTION, not only in the notices. The
    -- Supabase SQL editor does not surface NOTICE, so a bare count leaves you
    -- knowing how many checks broke and not which - a second run just to find
    -- out, which is what portal_auth_isolation.sql cost before it was fixed.
    raise exception E'% RLS isolation check(s) FAILED:\n%',
      failures, array_to_string(fails, E'\n');
  end if;
end
$$;

-- Nothing is kept. The two people, their purchases and the temp table all go.
rollback;

-- Belt and braces: prove the test data really is gone. Expect ZERO rows.
--
-- The underscores are escaped here and in the five patterns above. `_` is LIKE's
-- single-character wildcard, so the unescaped `'__rls_test_%'` means "any two
-- characters, then rls, then any character, then test". That could only ever
-- over-match, never hide a failure, and a WL key is digits - it would have to
-- contain the literal substrings `rls` and `test` to collide, so this was not
-- wrong in practice. The same pattern in portal_auth_isolation.sql WAS: it
-- matched three real students' surnames and reported a clean rollback as
-- surviving test data. Escaped in both, so neither can start lying later.
select uid, first_name from public.person where uid like '\_\_rls\_test\_%';
