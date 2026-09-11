-- =============================================================================
-- 0006  created_at and updated_at on every table
--
-- Self-contained: creates public.set_updated_at() itself, so it can be run on
-- its own. 0005 holds the same function as its canonical definition.
--
-- WHAT THIS FIXES. The timestamp columns were inconsistent across the earlier
-- migrations: person, purchase, purchase_item, session and attendance had
-- `first_seen_at`; lead had `created_at`; location, service, purchase_payment,
-- purchase_account_credit and session_staff had neither. Nothing had a working
-- `updated_at`.
--
-- After this, every table has the same three, meaning the same thing everywhere:
--   created_at  when the row first appeared here
--   updated_at  when the row last CHANGED here, maintained by trigger
--   synced_at   when the row was last read back from WL, changed or not
--
-- created_at and updated_at are the pair asked for. synced_at is kept because it
-- answers a different question: a sync that finds nothing new moves synced_at
-- and leaves updated_at alone, which is exactly how you tell "confirmed
-- unchanged an hour ago" from "nobody has looked at this in a week".
--
-- first_seen_at is RENAMED, not dropped and re-added - a rename keeps whatever
-- values are already in there. Everything is guarded so the script can be run
-- more than once, and against a database where 0004 has not been applied yet.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The trigger function, created here too so this file stands alone
-- -----------------------------------------------------------------------------
-- 0005 is the canonical home for this and is worth keeping - it is the one
-- place to change the behaviour. But `create or replace` is idempotent and
-- costs nothing, and requiring two files to be run in the right order in a SQL
-- editor is a footgun that fires every time. Running 0005 first is still fine;
-- this simply makes running 0006 alone work too.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'person', 'lead',
    'location', 'service', 'purchase', 'purchase_item',
    'purchase_payment', 'purchase_account_credit',
    'session', 'session_staff', 'attendance'
  ]
  loop
    -- Skip anything not created yet, so this survives a partial apply.
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      raise notice 'skipped % - table does not exist yet', t;
      continue;
    end if;

    -- 1. first_seen_at -> created_at, preserving the values already stored.
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'first_seen_at'
    ) and not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'created_at'
    ) then
      execute format('alter table public.%I rename column first_seen_at to created_at', t);
      raise notice '% : renamed first_seen_at -> created_at', t;
    end if;

    -- 2. created_at where there was none.
    execute format(
      'alter table public.%I add column if not exists created_at timestamptz not null default now()', t);

    -- 3. updated_at. Backfilled to created_at rather than now(), so an existing
    --    row does not claim it was modified the moment this migration ran.
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'updated_at'
    ) then
      execute format(
        'alter table public.%I add column updated_at timestamptz not null default now()', t);
      execute format('update public.%I set updated_at = created_at', t);
      raise notice '% : added updated_at, backfilled from created_at', t;
    end if;

    -- 4. synced_at for the tables that never had one.
    execute format(
      'alter table public.%I add column if not exists synced_at timestamptz not null default now()', t);

    -- 5. The trigger. Dropped first so re-running does not stack duplicates.
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t);
  end loop;

  raise notice 'done - every existing table now has created_at, updated_at and synced_at';
end
$$;

-- -----------------------------------------------------------------------------
-- The views select columns by name, so they still reference first_seen_at.
-- Rebuilt here against the new names.
-- -----------------------------------------------------------------------------
-- DROPPED, not replaced. `create or replace view` refuses to rename a column
-- that already exists - "42P16: cannot change name of view column first_seen_at
-- to created_at" - because a replace has to keep the old output signature.
-- Dropping first costs nothing: a view holds no data, and nothing depends on
-- these two.
drop view if exists public.teacher;
drop view if exists public.client;

create view public.client as
  select uid, k_business, first_name, last_name, email, phone, phone_home,
         phone_work, date_of_birth, k_login_type, text_login_type, text_member,
         ghl_contact_id, ghl_match_state, created_at, updated_at, synced_at
  from public.person;

create view public.teacher as
  select k_staff, uid, k_business, first_name, last_name, email, phone,
         is_class, is_appointment, is_event, service_count,
         (is_class or is_appointment or is_event) as is_teaching,
         created_at, updated_at, synced_at
  from public.person
  where k_staff is not null;

-- Views do not inherit RLS from the table underneath - they run as their owner
-- unless told otherwise, which would leave the policies on person decorative.
alter view public.client  set (security_invoker = on);
alter view public.teacher set (security_invoker = on);

-- =============================================================================
-- Verification. Expect every table to show all three columns and a trigger.
-- =============================================================================
select
  c.relname as table_name,
  bool_or(a.attname = 'created_at') as has_created_at,
  bool_or(a.attname = 'updated_at') as has_updated_at,
  bool_or(a.attname = 'synced_at')  as has_synced_at,
  exists (
    select 1 from pg_trigger tg
    where tg.tgrelid = c.oid and tg.tgname = c.relname || '_set_updated_at'
  ) as has_trigger
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'person', 'lead', 'location', 'service', 'purchase', 'purchase_item',
    'purchase_payment', 'purchase_account_credit',
    'session', 'session_staff', 'attendance'
  )
group by c.relname, c.oid
order by c.relname;
