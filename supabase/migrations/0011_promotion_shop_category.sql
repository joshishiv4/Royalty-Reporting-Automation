-- =============================================================================
-- 0011  promotion / shop_category  (reference data everything else joins to)
--
-- Two business-wide lookup tables. Both were probed live 24 Aug 2026 against dev,
-- and both endpoints exist and answer `status: "ok"` - unlike the client report
-- (task 017, still blocked) and the guessed service-catalogue endpoint (task 020,
-- /v1/service* all 404, service detail is derived from purchase items instead).
--
-- WHERE THE ROWS COME FROM
--   promotion      /v1/classes/promotion  (needs k_location - it is PER-LOCATION,
--                  not business-wide as the P5.6 note assumed). k_promotion is
--                  unique across the business, so the SAME promotion surfaces
--                  under several locations and the upsert on k_promotion dedupes
--                  it. Observed at k_location 244238: a_promotion held 12 rows.
--   shop_category  /v1/shop/category  (works with NO k_location - genuinely
--                  business-wide). Observed: a_shop_category held 5 rows.
--
-- A CLAUDE.md TRAP, INVERTED. The house rule is "WL list endpoints return keyed
-- objects, iterate Object.values()". These two are the exception: a_promotion and
-- a_shop_category arrive as JSON ARRAYS. The parsers handle both shapes so a
-- future keying change on WL's side does not silently drop every row.
--
-- ALL WL KEYS ARE TEXT. k_promotion / k_shop_category arrive quoted
-- ("1486525", "1033035") and are kept text - a leading zero is lost as a number.
--
-- i_order and id_program arrive as small numbers/numeric strings. i_order is a
-- genuine ordering integer and is stored as one; id_program is WL's program enum
-- and is kept as text alongside the promotion for reference, not parsed.
-- =============================================================================

-- The updated_at trigger function, created here too so this file stands alone
-- (0005 is its canonical home; `create or replace` is idempotent and costs
-- nothing - see the note in 0006).
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
-- promotion - a bookable promotion (a class/enrollment offering), per location
-- -----------------------------------------------------------------------------
create table if not exists public.promotion (
  k_promotion  text        primary key,
  k_business   text        not null,
  title        text,
  -- WL's program enum (id_program). Kept as text for reference; not a key we
  -- join on, so it is not parsed to an integer.
  id_program   text,
  is_active    boolean     not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  synced_at    timestamptz not null default now()
);

drop trigger if exists promotion_set_updated_at on public.promotion;
create trigger promotion_set_updated_at
  before update on public.promotion
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- shop_category - a storefront category, business-wide
-- -----------------------------------------------------------------------------
create table if not exists public.shop_category (
  k_shop_category  text        primary key,
  k_business       text        not null,
  title            text,
  description      text,
  -- Display order. Arrives as a numeric string ("0", "3", "4"); stored as the
  -- integer it is, so sorting is numeric and not "10" < "2".
  i_order          integer,
  is_system        boolean     not null default false,
  is_default       boolean     not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz not null default now()
);

drop trigger if exists shop_category_set_updated_at on public.shop_category;
create trigger shop_category_set_updated_at
  before update on public.shop_category
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Verification. Expect both tables present, each with the three timestamps and a
-- trigger.
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
  and c.relname in ('promotion', 'shop_category')
group by c.relname, c.oid
order by c.relname;
