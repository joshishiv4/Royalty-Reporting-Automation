-- =============================================================================
-- 0009  raw_link  - provenance that survives contact with the real API
--
-- WHAT 0008 GOT WRONG. It put a single raw_wl_id column on each typed table,
-- which assumes one typed row comes from one fetch. It does not. The important
-- tables are assembled from two calls each:
--
--   purchase   /v1/profile/purchase/list  -> k_purchase, dt_add, s_title, uid
--              /v1/purchase/receipt       -> m_total, m_tax, m_discount, payments
--   person     /v1/staff/list             -> k_staff, uid, is_class, service_count
--              /v1/user?uid=              -> email, phone, address, dob, type
--   session    /v1/classes/list           -> k_class, k_class_period, i_capacity
--              /v1/schedule/class/view    -> who taught it, the times
--
-- With one column, whichever fetch it points at, the other half of the row has no
-- provenance. On `purchase` that half is the MONEY - the one value a royalty is
-- calculated from, and the one most likely to need re-deriving.
--
-- The other direction was already fine: a GHL page of 100 contacts produces 100
-- person rows, and all 100 can point at the same raw row. It is one-entity-from-
-- many-fetches that a single column cannot express. So the relationship is
-- many-to-many, and this is the table for it.
--
-- WHY field_group EARNS ITS PLACE. It says which PART of the typed row a given
-- fetch supplied. That is what makes the ticket's promise real: if m_total turns
-- out to be decoded wrongly, the re-parse targets the receipt rows and leaves the
-- purchase/list rows alone. Without it, re-deriving one field means re-reading
-- every payload that ever touched the row.
--
-- Known groups so far - text, not an enum, because new ones arrive with new
-- endpoints:
--   person    'staff' | 'contact'
--   purchase  'metadata' | 'money'
--   session   'definition' | 'assignment'
--   any       'all'  (the whole row came from one fetch)
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create table if not exists public.raw_link (
  id               uuid        primary key default gen_random_uuid(),

  -- Exactly one source. Both nullable individually, constrained below.
  raw_wl_id        uuid        references public.raw_wl  (id) on delete cascade,
  raw_ghl_id       uuid        references public.raw_ghl (id) on delete cascade,

  -- Which typed row this fetch fed. There is deliberately NO foreign key here:
  -- table_name is dynamic, and Postgres cannot reference a table named by a
  -- column. The trade is real - nothing stops a typo - so the writer is the only
  -- thing that should insert here, and the verification at the bottom of this
  -- file lists any table_name that is not a table.
  table_name       text        not null,
  -- Composite keys are joined with '|' in primary-key order, e.g. a session is
  -- '18448467|2026-08-19T00:00:00Z'. Same convention as sync_queue.target_key.
  record_key       text        not null,

  -- Which part of the row came from this fetch. NOT NULL with a default so the
  -- unique indexes below actually dedupe - a nullable column would let the same
  -- link be inserted twice.
  field_group      text        not null default 'all',

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One source per link, never both and never neither. A row with both set would
  -- claim a WL fetch and a GHL fetch supplied the same fields.
  constraint raw_link_exactly_one_source check (
    (raw_wl_id is not null and raw_ghl_id is null)
    or (raw_wl_id is null and raw_ghl_id is not null)
  )
);

comment on table public.raw_link is
  'Many-to-many between raw payloads and typed rows. One purchase is assembled '
  'from purchase/list and purchase/receipt, so a single column on purchase could '
  'only ever record half of where it came from.';
comment on column public.raw_link.field_group is
  'Which part of the typed row this fetch supplied, so re-deriving one field '
  'targets only the payloads that carried it.';
comment on column public.raw_link.table_name is
  'No foreign key is possible - the target table is named by data, not by '
  'schema. Only the writer should insert here.';

-- Dedupe, per source. Two partial indexes rather than one, because a NULL
-- raw_wl_id on every GHL row would make a single index useless for dedupe.
create unique index if not exists raw_link_wl_unique
  on public.raw_link (raw_wl_id, table_name, record_key, field_group)
  where raw_wl_id is not null;
create unique index if not exists raw_link_ghl_unique
  on public.raw_link (raw_ghl_id, table_name, record_key, field_group)
  where raw_ghl_id is not null;

-- "Where did this row come from" - the question the ticket asks.
create index if not exists raw_link_record_idx
  on public.raw_link (table_name, record_key);
-- "What did this fetch produce" - the reverse, for a re-parse.
create index if not exists raw_link_wl_idx on public.raw_link (raw_wl_id)
  where raw_wl_id is not null;
create index if not exists raw_link_ghl_idx on public.raw_link (raw_ghl_id)
  where raw_ghl_id is not null;
-- "Every row whose money came from a receipt" - the targeted re-parse.
create index if not exists raw_link_field_group_idx
  on public.raw_link (table_name, field_group);

drop trigger if exists raw_link_set_updated_at on public.raw_link;
create trigger raw_link_set_updated_at
  before update on public.raw_link
  for each row execute function public.set_updated_at();

alter table public.raw_link enable row level security;

-- -----------------------------------------------------------------------------
-- Remove the single-column provenance from 0008
-- -----------------------------------------------------------------------------
-- Dropped rather than kept alongside raw_link. Two places recording the same
-- fact is how they come to disagree, and there is no data to preserve: nothing
-- writes to these tables yet, so every one of these columns is empty.
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array[
    'person', 'lead',
    'purchase', 'purchase_item', 'purchase_payment', 'purchase_account_credit',
    'service', 'location',
    'session', 'session_staff', 'attendance'
  ]
  loop
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      continue;
    end if;

    -- Refuse to drop a populated column. Expected to be 0 everywhere.
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'raw_wl_id'
    ) then
      execute format('select count(*) from public.%I where raw_wl_id is not null', t) into n;
      if n > 0 then
        raise exception
          'public.%.raw_wl_id holds % rows of provenance. Migrate them into raw_link before dropping.', t, n;
      end if;
    end if;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'raw_ghl_id'
    ) then
      execute format('select count(*) from public.%I where raw_ghl_id is not null', t) into n;
      if n > 0 then
        raise exception
          'public.%.raw_ghl_id holds % rows of provenance. Migrate them into raw_link before dropping.', t, n;
      end if;
    end if;

    execute format('alter table public.%I drop column if exists raw_wl_id', t);
    execute format('alter table public.%I drop column if exists raw_ghl_id', t);
  end loop;

  raise notice 'single-column provenance removed; raw_link is now the only record';
end
$$;

-- =============================================================================
-- Verification
-- =============================================================================

-- 1. raw_link exists, with its constraint and RLS.
select c.relname as table_name,
       c.relrowsecurity as rls_on,
       (select count(*) from pg_constraint where conrelid = c.oid and contype = 'c') as check_constraints,
       (select count(*) from pg_index where indrelid = c.oid) as indexes
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'raw_link';

-- 2. No typed table still carries a single-column pointer. Expect ZERO rows.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and column_name in ('raw_wl_id', 'raw_ghl_id')
  and table_name <> 'raw_link'
order by table_name;

-- 3. Any table_name in raw_link that is not a real table. Expect ZERO rows -
--    the price of having no foreign key on that column is checking it.
select distinct l.table_name as orphan_table_name
from public.raw_link l
where not exists (
  select 1 from pg_tables t
  where t.schemaname = 'public' and t.tablename = l.table_name
);
