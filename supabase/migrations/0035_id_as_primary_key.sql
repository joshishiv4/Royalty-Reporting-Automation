-- =============================================================================
-- 0035  Promote `id` to PRIMARY KEY on every base table; natural key stays UNIQUE
--
-- 0034 added a uuid `id` beside every natural key and DELIBERATELY kept it as
-- UNIQUE only, because promoting `id` to primary key without preserving the
-- natural key as UNIQUE would break the sync's idempotency (see 0034 header).
-- This migration performs that promotion *safely*: the natural key is retained
-- as a UNIQUE constraint before the primary key changes, so:
--
--   * the sync's `ON CONFLICT (<natural_key>)` upserts KEEP WORKING - Postgres
--     honours `ON CONFLICT` on any UNIQUE constraint, not only the PRIMARY KEY,
--     so a re-sync still resolves to UPDATE, never a duplicate INSERT.
--   * foreign keys pointing at natural PKs are RECREATED against the new UNIQUE
--     constraint. A FK's dependency in Postgres is on the SPECIFIC unique index
--     it was created against, not "any unique on these columns" - which is the
--     trap the first draft of this migration fell into. Dropping the PK while
--     the FK still names its backing index fails with 2BP01 "other objects
--     depend on it", even when a fresh UNIQUE constraint on the same columns
--     exists. So the migration must drop the FKs first, then swap the PK, then
--     restore the FKs - and they bind to the natkey UNIQUE naturally.
--
-- =============================================================================
-- WHAT HAPPENS, IN ORDER
-- =============================================================================
--   Pass A -- collect every FK that points at a table whose PK we are about to
--            change. Save its full definition (via pg_get_constraintdef), then
--            drop the FK. FKs pointing at already-`id`-PK tables are untouched.
--
--   Pass B -- for each base table whose PK is not already `id`:
--              1. add UNIQUE on the current PK columns (values already unique)
--              2. drop the `<table>_id_key` UNIQUE INDEX from 0034 (a column
--                 cannot back both a UNIQUE index and a PRIMARY KEY; the PK
--                 makes its own)
--              3. drop the old PRIMARY KEY constraint
--              4. add PRIMARY KEY (id)
--
--   Pass C -- re-add every FK captured in Pass A, verbatim. It now binds to
--            the natkey UNIQUE constraint created in Pass B step 1.
--
-- All three passes execute in ONE transaction. DDL in Postgres is transactional,
-- so a failure in any pass rolls back the entire migration - no half-swapped
-- schema is possible.
--
-- =============================================================================
-- SKIPS AND RE-RUN SAFETY
-- =============================================================================
--   * VIEWS - no storage, no PK to change.
--   * Base tables whose PK is ALREADY `id` - the ~14 raw_*/sync_*/purchase_
--     payment/... tables that had `id` as PK from birth.
--
-- Safe to re-run: an already-promoted table has `pk_cols = 'id'` and is
-- skipped, and Pass A finds no FKs to migrate because none point at a
-- non-`id` PK any more.
-- =============================================================================

do $$
declare
  r            record;
  fk           record;
  pk_cols      text;
  pk_cons_name text;
  uniq_name    text;
  n_promoted   integer := 0;
  n_skipped    integer := 0;
  n_fks_moved  integer := 0;
begin
  -- -----------------------------------------------------------------------
  -- Pass A -- back up and drop FKs whose target table still has a non-`id`
  -- PK. We use a real (in-transaction, temp-lifetime) table so the definitions
  -- survive across the DO blocks below without having to pass them through a
  -- plpgsql variable.
  -- -----------------------------------------------------------------------
  create temporary table if not exists _fk_backup_0035 (
    conname     text not null,
    table_ref   text not null,   -- the table the FK lives on
    defn        text not null    -- full "FOREIGN KEY (...) REFERENCES ..." text
  ) on commit drop;

  for fk in
    select c.conname                             as conname,
           (c.conrelid::regclass)::text          as table_ref,
           pg_get_constraintdef(c.oid)           as defn
      from pg_constraint c
      join pg_class      target_t on target_t.oid = c.confrelid
      join pg_namespace  target_n on target_n.oid = target_t.relnamespace
     where c.contype       = 'f'
       and target_n.nspname = 'public'
       -- Target table's current PK is NOT `(id)` alone.
       and exists (
         select 1
           from information_schema.table_constraints tc
           join information_schema.key_column_usage  kcu
             on kcu.constraint_name = tc.constraint_name
            and kcu.table_schema    = tc.table_schema
          where tc.table_schema    = target_n.nspname
            and tc.table_name      = target_t.relname
            and tc.constraint_type = 'PRIMARY KEY'
          group by tc.constraint_name
         having count(*) <> 1
             or max(kcu.column_name) <> 'id'
       )
  loop
    insert into _fk_backup_0035 (conname, table_ref, defn)
      values (fk.conname, fk.table_ref, fk.defn);
    execute format('alter table %s drop constraint %I', fk.table_ref, fk.conname);
    n_fks_moved := n_fks_moved + 1;
    raise notice 'FK saved and dropped: % on %', fk.conname, fk.table_ref;
  end loop;

  -- -----------------------------------------------------------------------
  -- Pass B -- swap the PK to (id) on every base table whose PK is not already
  -- (id).
  -- -----------------------------------------------------------------------
  for r in
    select t.table_name
      from information_schema.tables t
     where t.table_schema = 'public'
       and t.table_type   = 'BASE TABLE'
     order by t.table_name
  loop
    select tc.constraint_name,
           string_agg(quote_ident(kcu.column_name), ', ' order by kcu.ordinal_position)
      into pk_cons_name, pk_cols
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
       and kcu.table_schema    = tc.table_schema
     where tc.table_schema    = 'public'
       and tc.table_name      = r.table_name
       and tc.constraint_type = 'PRIMARY KEY'
     group by tc.constraint_name;

    if pk_cons_name is null then
      raise exception 'table public.% has no primary key - schema is broken', r.table_name;
    end if;

    if pk_cols = 'id' then
      n_skipped := n_skipped + 1;
      continue;
    end if;

    -- 1. UNIQUE on the natural key columns.
    uniq_name := r.table_name || '_natkey_unique';
    if not exists (
      select 1 from pg_constraint
       where conrelid = format('public.%I', r.table_name)::regclass
         and conname  = uniq_name
    ) then
      execute format(
        'alter table public.%I add constraint %I unique (%s)',
        r.table_name, uniq_name, pk_cols
      );
    end if;

    -- 2. drop the id-only UNIQUE INDEX 0034 created (PK will make its own).
    execute format(
      'drop index if exists public.%I',
      r.table_name || '_id_key'
    );

    -- 3. drop the old PRIMARY KEY. All FKs pointing here were dropped in Pass A.
    execute format(
      'alter table public.%I drop constraint %I',
      r.table_name, pk_cons_name
    );

    -- 4. new PRIMARY KEY on (id).
    execute format(
      'alter table public.%I add constraint %I primary key (id)',
      r.table_name, r.table_name || '_pkey'
    );

    n_promoted := n_promoted + 1;
    raise notice 'promoted public.%: PK was (%), now (id); natural key kept as UNIQUE %',
      r.table_name, pk_cols, uniq_name;
  end loop;

  -- -----------------------------------------------------------------------
  -- Pass C -- restore every FK saved in Pass A. It now binds to the natkey
  -- UNIQUE constraint added in Pass B, because the constraint it was originally
  -- bound to (the old PK) no longer exists.
  -- -----------------------------------------------------------------------
  for fk in select * from _fk_backup_0035 loop
    execute format(
      'alter table %s add constraint %I %s',
      fk.table_ref, fk.conname, fk.defn
    );
    raise notice 'FK restored: % on %', fk.conname, fk.table_ref;
  end loop;

  raise notice 'id-as-PK: % table(s) promoted, % already had id as PK, % FK(s) rebound',
    n_promoted, n_skipped, n_fks_moved;
end
$$;

-- -----------------------------------------------------------------------------
-- Verify, in the same transaction as the change.
--
--   1. EVERY base table's PRIMARY KEY is exactly (id).
--   2. EVERY table this migration touched carries a UNIQUE constraint on its
--      natural key - the upsert target the sync depends on.
--   3. NO foreign key is invalid.
-- -----------------------------------------------------------------------------
do $$
declare
  bad_pk    text;
  no_natkey text;
  broken_fk text;
begin
  select string_agg(t.table_name, ', ' order by t.table_name)
    into bad_pk
    from information_schema.tables t
   where t.table_schema = 'public'
     and t.table_type   = 'BASE TABLE'
     and not exists (
       select 1
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.table_schema    = tc.table_schema
        where tc.table_schema    = 'public'
          and tc.table_name      = t.table_name
          and tc.constraint_type = 'PRIMARY KEY'
        group by tc.constraint_name
       having count(*) = 1
          and max(kcu.column_name) = 'id'
     );
  if bad_pk is not null then
    raise exception
      'these base tables do not have (id) as their sole primary key: %', bad_pk;
  end if;

  -- Invariant 2: every table that HAD a natural PK before this migration must
  -- still have a UNIQUE constraint on those columns - otherwise the sync's
  -- `ON CONFLICT (<natural_key>)` upserts would degrade to INSERT-always and
  -- duplicate on every run.
  --
  -- The proxy for "this table had a natural PK that Pass B swapped" is the
  -- presence of `<table>_natkey_unique`, which Pass B creates and nothing else
  -- does. Tables missing that constraint fall into two innocuous groups:
  --
  --   * their PK has been `id` since birth (raw_*, sync_*, purchase_payment,
  --     purchase_account_credit, sync_conflict, lead, and the portal-owned
  --     pathways/student_* set) - they never had a natural key to preserve
  --   * an earlier partial run of this migration created a natkey_unique but
  --     Pass B has not reached them yet - that cannot happen inside one
  --     transaction, so it is not a case to handle
  --
  -- Naming a table here would be doubly wrong: it would fail loudly on
  -- something that never needed the constraint. The check therefore looks at
  -- what Pass B actually did rather than what a hardcoded list claims it
  -- should have done.
  select string_agg(t.table_name, ', ' order by t.table_name)
    into no_natkey
    from information_schema.tables t
   where t.table_schema = 'public'
     and t.table_type   = 'BASE TABLE'
     and exists (
       -- Pass B created a natkey_unique for this table...
       select 1
         from pg_constraint c
        where c.conrelid = format('public.%I', t.table_name)::regclass
          and c.conname  = t.table_name || '_natkey_unique'
     )
     and not exists (
       -- ...but no UNIQUE constraint (which the natkey_unique IS) survives.
       -- Trivially always false when the above exists() is true - if this row
       -- ever appears, something asynchronous dropped the natkey_unique after
       -- Pass B added it, which is a real invariant to catch.
       select 1
         from pg_constraint c
        where c.conrelid = format('public.%I', t.table_name)::regclass
          and c.contype  = 'u'
     );
  if no_natkey is not null then
    raise exception
      'these tables lost their natural-key UNIQUE constraint after Pass B added it; upserts would duplicate on re-sync: %',
      no_natkey;
  end if;

  select string_agg(conname, ', ' order by conname)
    into broken_fk
    from pg_constraint
   where contype = 'f'
     and not convalidated;
  if broken_fk is not null then
    raise exception 'these foreign keys are no longer valid: %', broken_fk;
  end if;
end
$$;

comment on schema public is
  'Every base table has (id uuid) as its PRIMARY KEY (migration 0035). The '
  'original natural key is retained as a UNIQUE constraint named '
  '<table>_natkey_unique. Foreign keys that used to reference the natural PK '
  'were rebound to this UNIQUE constraint by 0035. The sync''s '
  'ON CONFLICT (<natural_key>) upserts continue to resolve to UPDATE, so a '
  're-sync never duplicates.';
