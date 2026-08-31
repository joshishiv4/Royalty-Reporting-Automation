-- =============================================================================
-- 0034  A uuid `id` on every table
--
-- Requested so the portal (and any ORM pointed at this database) has one
-- predictable surrogate key per row instead of eleven different natural keys -
-- `uid`, `k_purchase`, `k_period` + `dt_start_utc`, and so on.
--
-- =============================================================================
-- THE ONE THING THIS MIGRATION MUST NOT DO
-- =============================================================================
-- `id` is ADDED. Every natural primary key and unique constraint STAYS exactly
-- as it was, and `id` is deliberately NOT made the primary key.
--
-- The whole sync is idempotent because of those natural keys. Every write is an
-- upsert on one: `on_conflict=uid` for person, `k_purchase` for purchase,
-- `k_period,dt_start_utc,uid` for attendance. That is what lets a run be
-- repeated, interrupted, or overlapped without piling up copies - and it is
-- relied on in a dozen places.
--
-- Promote `id` to primary key and drop the natural unique, and a random uuid
-- becomes the conflict target. Nothing would ever conflict again, so every
-- re-sync would INSERT afresh: 1,286 clients would become 2,572, then 3,858.
-- Silently, with every run reporting success. This migration therefore only
-- ever adds.
--
-- =============================================================================
-- WHY A LOOP AND NOT A LIST OF ALTER STATEMENTS
-- =============================================================================
-- Fifty relations live in this schema and eighteen of them are VIEWS - teacher,
-- client, data_health, revenue_month, session_outcome and the rest. A view
-- cannot be given a column, and a hand-written list would either miss a table or
-- try to alter a view. `information_schema` knows which is which, so it decides.
--
-- Fourteen tables already carry a uuid `id` (raw_wl, raw_ghl, raw_link,
-- sync_queue, purchase_payment, ...). Those are skipped, which is also what
-- makes this safe to re-run.
--
-- =============================================================================
-- EXISTING ROWS GET DISTINCT VALUES, AND THAT IS NOT AN ACCIDENT
-- =============================================================================
-- Postgres 11+ normally makes ADD COLUMN ... DEFAULT free by storing ONE value
-- for every existing row. That fast path applies only to a NON-VOLATILE default.
-- gen_random_uuid() is volatile, so the table is rewritten and the default is
-- evaluated per row - every existing row gets its own uuid, which is the whole
-- point. It does mean a full rewrite: session and attendance are ~43k rows each
-- and purchase ~22k, so this is seconds, not minutes.
--
-- Safe to re-run.
-- =============================================================================

do $$
declare
  r record;
  n_added integer := 0;
  n_skipped integer := 0;
begin
  for r in
    select t.table_name
      from information_schema.tables t
     where t.table_schema = 'public'
       -- BASE TABLE only: a view has no storage to add a column to.
       and t.table_type = 'BASE TABLE'
     order by t.table_name
  loop
    if exists (
      select 1
        from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name = r.table_name
         and c.column_name = 'id'
    ) then
      n_skipped := n_skipped + 1;
      continue;
    end if;

    execute format(
      'alter table public.%I add column id uuid not null default gen_random_uuid()',
      r.table_name
    );

    -- Unique so `id` can actually be used as a key by whatever reads this
    -- database. NOT a primary key: see the header - the natural key has to stay
    -- the conflict target or the sync stops being idempotent.
    execute format(
      'create unique index if not exists %I on public.%I (id)',
      r.table_name || '_id_key',
      r.table_name
    );

    n_added := n_added + 1;
    raise notice 'added id to public.%', r.table_name;
  end loop;

  raise notice 'uuid id: % table(s) given one, % already had one', n_added, n_skipped;
end
$$;

-- -----------------------------------------------------------------------------
-- Proof, in the same transaction as the change.
--
-- A migration that silently did nothing looks identical to one that worked, so
-- this fails loudly rather than leaving the question open. Every base table must
-- now have `id`, and no natural primary key may have been lost on the way.
-- -----------------------------------------------------------------------------
do $$
declare
  missing text;
  pk_less text;
begin
  select string_agg(t.table_name, ', ' order by t.table_name)
    into missing
    from information_schema.tables t
   where t.table_schema = 'public'
     and t.table_type = 'BASE TABLE'
     and not exists (
       select 1 from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = t.table_name
          and c.column_name = 'id'
     );
  if missing is not null then
    raise exception 'these base tables still have no id column: %', missing;
  end if;

  -- The failure this guards against is a future edit "tidying up" by making id
  -- the primary key. A table with no primary key at all is the footprint that
  -- leaves behind.
  select string_agg(t.table_name, ', ' order by t.table_name)
    into pk_less
    from information_schema.tables t
   where t.table_schema = 'public'
     and t.table_type = 'BASE TABLE'
     and not exists (
       select 1
         from information_schema.table_constraints tc
        where tc.table_schema = 'public'
          and tc.table_name = t.table_name
          and tc.constraint_type = 'PRIMARY KEY'
     );
  if pk_less is not null then
    raise exception
      'these base tables lost their primary key - the sync would duplicate on every run: %',
      pk_less;
  end if;
end
$$;

comment on schema public is
  'Every base table carries a uuid `id` (migration 0034) as a surrogate key for '
  'the portal. It is UNIQUE, never the PRIMARY KEY: the natural key stays the '
  'upsert conflict target, and that is what keeps a re-run from duplicating '
  'every row.';
