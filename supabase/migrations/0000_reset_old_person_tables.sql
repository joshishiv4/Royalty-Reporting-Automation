-- =============================================================================
-- 0000  reset the superseded schema
--
-- WHY THIS EXISTS. An earlier draft created client / staff / lead as three
-- TABLES. The design then changed to a single `person` table carrying the client
-- uid and the staff k_staff on ONE row, with `client` and `teacher` as views over
-- it. Postgres will not replace a table with a view, hence
-- "ERROR: 42809: client is not a view".
--
-- 0002 was applied too - the dependency check showed `purchase` holding two
-- foreign keys to `client`, one for the payer and one for the recipient. That
-- matters because 0002 uses `create table if not exists`: dropping only `client`
-- would leave `purchase` in place with its constraints stripped by CASCADE, and
-- re-running 0002 would skip the table and never restore them. So everything
-- from 0001 and 0002 is dropped and rebuilt from the migrations.
--
-- THIS DROPS DATA, AND IT REFUSES TO IF THERE IS ANY. The guard below aborts the
-- whole script the moment it finds a single row. Nothing writes to these tables
-- yet - there is no writer anywhere in the codebase - so the expected outcome is
-- that the guard passes silently. If it raises, STOP: the data is real and needs
-- moving before anything is dropped.
--
-- Safe to run more than once.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Guard: abort rather than destroy anything that has rows in it
-- -----------------------------------------------------------------------------
do $$
declare
  t          text;
  n          bigint;
  populated  text[] := '{}';
begin
  foreach t in array array[
    'client', 'staff', 'lead', 'person',
    'purchase', 'purchase_item', 'purchase_payment',
    'purchase_account_credit', 'service', 'location'
  ]
  loop
    -- Skip anything that does not exist; a partial apply is expected here.
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      continue;
    end if;

    execute format('select count(*) from public.%I', t) into n;
    if n > 0 then
      populated := populated || format('%s (%s rows)', t, n);
    end if;
  end loop;

  if array_length(populated, 1) > 0 then
    raise exception
      'Refusing to drop: these tables hold data -> %. Move it out first, then re-run.',
      array_to_string(populated, ', ');
  end if;

  raise notice 'Guard passed: every table is empty or absent. Dropping.';
end
$$;

-- -----------------------------------------------------------------------------
-- Drop, children before parents
-- -----------------------------------------------------------------------------
-- Dropped by ACTUAL object type, not by assumption. `drop view if exists` is
-- happy when the name is absent but ERRORS when the name is a table
-- ("42809: client is not a view"), and `drop table if exists` errors the same
-- way on a view. Since a half-applied run can leave either shape behind, the
-- type is read from the catalogue and the matching statement is issued.
do $$
declare
  t    text;
  kind char;
begin
  foreach t in array array[
    -- children first, then parents
    'teacher', 'client',
    'purchase_account_credit', 'purchase_payment', 'purchase_item', 'purchase',
    'service', 'location',
    'lead', 'staff', 'person'
  ]
  loop
    select c.relkind into kind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t;

    if kind is null then
      continue;                                   -- not there, nothing to do
    elsif kind = 'v' then
      execute format('drop view %I cascade', t);
      raise notice 'dropped view %', t;
    elsif kind = 'm' then
      execute format('drop materialized view %I cascade', t);
      raise notice 'dropped materialized view %', t;
    else
      execute format('drop table %I cascade', t);
      raise notice 'dropped table %', t;
    end if;

    kind := null;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Confirm the ground is clear. Expect ZERO rows back.
-- -----------------------------------------------------------------------------
-- pg_class, not pg_tables: a leftover VIEW would not show up in pg_tables and
-- would break the next migration exactly the way this script exists to fix.
select c.relname as still_present,
       case c.relkind when 'r' then 'table' when 'v' then 'view'
                      when 'm' then 'materialized view' else c.relkind::text end as kind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'client', 'staff', 'lead', 'person', 'teacher',
    'purchase', 'purchase_item', 'purchase_payment',
    'purchase_account_credit', 'service', 'location'
  );
