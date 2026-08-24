-- =============================================================================
-- 0012  service catalogue: service_category + service enrichment + resolution
--
-- Fills in the LAST of the P5.6 reference data (services and their categories)
-- and adds the "unresolved service" concept the board asked for.
--
-- WHAT CHANGED SINCE 0002/020
--   Task 020 recorded "WL exposes no service-detail endpoint (all /v1/service*
--   paths 404), so service title/is_package are DERIVED from purchase items".
--   That was true for the paths tried. Probed live 24 Aug 2026 the real catalogue
--   lives under a DIFFERENT path family:
--     /v1/appointment/book/service/list      -> a_service (KEYED OBJECT), per-location
--     /v1/appointment/book/service/category  -> a_category (ARRAY), per-location
--   So a service can now be RESOLVED from the catalogue, not only inferred from a
--   transaction. The derive-from-purchase path stays as the fallback for services
--   the bookable list does not carry - see below.
--
-- THE GAP THIS MODELS (board 5.6, tracked as Q19)
--   The bookable-service list returns only a handful (9 at the one live location)
--   while staff records reference ~200, and appointments point at services absent
--   from the list. A row that references such a service must STORE CLEANLY, not
--   fail - so `service.is_resolved` marks whether a service was ever seen in the
--   catalogue. A service that only ever arrived as a purchase/appointment FK stub
--   stays is_resolved = false: present, usable, and COUNTABLE as a gap.
--
-- WHY NO FK ON service.k_service_category
--   Same reason raw_link carries no FK on table_name and unknown services do not
--   fail their row: a service may name a category the /category list does not
--   return. A hard FK would reject the whole service row for a missing lookup,
--   which is exactly the failure this task exists to avoid. It is a plain text
--   key, kept as text like every other WL key (a leading zero is lost as a number).
-- =============================================================================

-- The updated_at trigger function, created here too so this file stands alone
-- (0005 is its canonical home; create or replace is idempotent - see 0006/0011).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- service_category - a bookable-service category, per location
-- (k_service_category is unique business-wide, so the same category surfaces
--  under several locations and the upsert collapses it to one row)
-- -----------------------------------------------------------------------------
create table if not exists public.service_category (
  k_service_category text        primary key,
  k_business         text        not null,
  title              text,
  -- WL's display order. Arrives as a numeric string ("29932"); stored as the
  -- integer it is, so sorting is numeric and not lexical.
  i_sort             integer,
  hide_application   boolean     not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  synced_at          timestamptz not null default now()
);

create index if not exists service_category_k_business_idx
  on public.service_category (k_business);

drop trigger if exists service_category_set_updated_at on public.service_category;
create trigger service_category_set_updated_at
  before update on public.service_category
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- service - enrich the existing table (0002) with real catalogue detail.
-- Additive and idempotent: `add column if not exists` so re-running is safe and
-- the columns the purchase writer already fills (title, is_package) are untouched.
-- -----------------------------------------------------------------------------
alter table public.service
  add column if not exists k_service_category text,
  -- Booked duration in minutes (WL's i_duration_real).
  add column if not exists i_duration        integer,
  add column if not exists is_bookable        boolean not null default false,
  -- The heart of this migration. Default FALSE: a service first seen as a
  -- purchase/appointment stub is unresolved until the catalogue confirms it. The
  -- catalogue writer sends is_resolved = true; the purchase writer NEVER sends
  -- this column, so a PostgREST merge-upsert of a stub cannot flip a resolved
  -- service back to unresolved (it writes only the columns present in the body).
  add column if not exists is_resolved        boolean not null default false;

comment on column public.service.is_resolved is
  'True once the service was seen in the bookable catalogue '
  '(/v1/appointment/book/service/list). False = only ever referenced by a '
  'transaction, never in the catalogue - a countable gap (Q19). Never flipped '
  'back to false by an upsert: only the catalogue writer sends this column.';
comment on column public.service.k_service_category is
  'WL k_service_category, kept as text with NO foreign key on purpose: a service '
  'may name a category the /category list omits, and a hard FK would fail the row.';

create index if not exists service_unresolved_idx
  on public.service (k_business) where is_resolved = false;

-- -----------------------------------------------------------------------------
-- unresolved_service - the gap, made countable.
--
-- One row per service that exists (referenced by a transaction) but was never in
-- the bookable catalogue. `select count(*) from unresolved_service` is the size of
-- the gap; the rows themselves say which services need chasing (Q19).
-- -----------------------------------------------------------------------------
create or replace view public.unresolved_service as
  select
    k_service,
    k_business,
    title,        -- may be the purchase-derived title, or null if never carried one
    is_package
  from public.service
  where is_resolved = false;

comment on view public.unresolved_service is
  'Services referenced by a transaction but absent from the bookable catalogue. '
  'Countable gap for Q19: count(*) is its size, the rows are what to chase.';

-- =============================================================================
-- Verification. Expect service_category present with its three timestamps and a
-- trigger, the four new service columns present, and the view resolvable.
-- =============================================================================
select
  (select bool_and(present) from (
     select (count(*) = 1) as present from information_schema.columns
       where table_schema = 'public' and table_name = 'service_category'
         and column_name = 'k_service_category'
     union all
     select (count(*) = 4) from information_schema.columns
       where table_schema = 'public' and table_name = 'service'
         and column_name in ('k_service_category','i_duration','is_bookable','is_resolved')
   ) checks) as schema_ok,
  exists (
    select 1 from pg_trigger
    where tgname = 'service_category_set_updated_at'
  ) as has_trigger,
  exists (
    select 1 from pg_views where schemaname = 'public' and viewname = 'unresolved_service'
  ) as has_view;
