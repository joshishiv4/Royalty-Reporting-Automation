-- =============================================================================
-- 0038  pay_transaction / pay_transaction_item  (the money as WL's own reports
--       state it, business-wide, without enumerating one client at a time)
--
-- WHERE THE ROWS COME FROM
--   pay_transaction       POST /v1/report/query, cid_report 799
--                         "All Transactions (Payment View)" - one row per payment
--   pay_transaction_item  POST /v1/report/query, cid_report 739
--                         "All Transactions (Item View)"    - one row per item
--
-- Both were probed live against dev on 17 Sep 2026, window 1980-01-01..today:
-- 739 returned 10,913 rows over 11 pages at i_limit 1000; 799 returned 10,196.
-- Full measurements are in docs/WL-API-NOTES.md.
--
-- =============================================================================
-- WHY THESE ARE NEW TABLES AND NOT MORE COLUMNS ON purchase / purchase_item
-- =============================================================================
-- Because they are a different population, and merging them would misstate both.
--
--   purchase_item rows in this database   20,561
--   739 item rows for ALL TIME            10,913
--
-- The report only lists items a money movement touched. A free item, a comped
-- one, an unpaid balance and a membership seeded but never charged are all real
-- purchase_items and appear in NEITHER report. Conversely the report carries
-- facts the purchase path cannot see at all - k_pay_transaction, the revenue
-- category, the batch/processor reference, the actor who took the payment, and a
-- refund's OWN DATE (see below). So the report is a second, overlapping witness
-- to the same money. Two witnesses, two tables, joined on k_purchase /
-- k_purchase_item when a reader wants both.
--
-- THIS IS THE FIRST DATED REFUND. DATA-MODEL records that `purchase.m_refund`
-- carries no date, so a refund lands in the original purchase's month. A refund
-- here is its own row, with its own `dtu_date` and a negative amount - which is
-- what makes a monthly figure that moves when a refund is issued possible at
-- all. Nothing in this migration changes purchase.m_refund; it remains
-- authoritative for the purchase path. The two must be reconciled before either
-- is used for a royalty figure, and that reconciliation is not written yet.
--
-- =============================================================================
-- THE ROW IDENTITY IS A HASH, BECAUSE WL DOES NOT PUBLISH ONE
-- =============================================================================
-- Every candidate natural key was measured over all 10,913 / 10,196 rows:
--
--   739  k_purchase_item                              8,778 distinct (2,135 short)
--        k_purchase_item + k_id + id_table           10,656 distinct   (257 short)
--        ...+ dtu_date + m_amount                    10,882 distinct    (31 short)
--   799  k_pay_transaction                            9,419 distinct   (777 short)
--        k_pay_transaction + i_row_order + dtu_date   9,547 distinct   (649 short)
--
-- And `k_pay_transaction` is NULL on 10,838 of the 10,913 item-view rows, so the
-- column that names the transaction is absent from the report named after it.
--
-- What the "duplicates" actually are was checked rather than assumed: a sale row
-- and its later refund/void row share the item key and differ in sign and date
-- (`i_quantity` 1 vs -1, `m_amount` "500.00" vs "-500.00"). Those are two
-- events and both must be kept - which rules out every key above, since each one
-- collapses them.
--
-- So identity is `row_hash`: a sha256 over exactly the field values this schema
-- stores, in a fixed order. Re-reading the same report writes the same hash, so
-- a re-run is an upsert and never a duplicate - the same idempotency every other
-- pass gets from a WL key.
--
-- WHY THE HASH IS OVER THE STORED SUBSET AND NOT THE WHOLE ROW. The whole row
-- carries `o_purchase_item_title_link.a_item[].url` values containing a signed
-- `s_filter` token and several `html_tooltip_content` blobs. Those are rendering
-- artefacts, free to change between builds, and hashing them would make the same
-- transaction arrive under a new identity and insert a second copy.
--
-- `i_occurrence` IS THE REMAINDER, AND IT IS SMALL AND MEASURED. After hashing
-- the stored subset, 739 has 14 groups of repeats (2 byte-identical, 12 that
-- differ only in the item TITLE - which is why item_title is stored and hashed)
-- and 799 has 649 groups that are byte-identical across all 140 fields. A
-- byte-identical row pair is indistinguishable by construction: nothing in the
-- payload separates them. Rather than collapse them and quietly lose 649 rows
-- from a revenue total, the writer numbers repeats 0, 1, 2... within one read of
-- one window.
--
-- ITS ONE LIMIT, STATED PLAINLY: the counter restarts if a window's paging is
-- interrupted and resumes in a later invocation, so an interrupted read can
-- merge two identical rows. It can therefore UNDERCOUNT a repeat, never
-- double-count one. Half of the repeat groups are non-adjacent in report order,
-- so this cannot be fixed by sorting.
--
-- =============================================================================
-- MONEY IS numeric(12,2), AND WL SOMETIMES SENDS FOUR DECIMALS
-- =============================================================================
-- Observed verbatim: `m_amount` "239.00", `m_sale` "239.0000", `m_total_tax`
-- "0.0000", refund negatives as "-500.00". Stored at the house precision of 2 -
-- the project rule, and every other money column here - so a four-decimal value
-- is rounded on write. No observed value has ever carried a non-zero third
-- decimal; if one appears, the report row is still in raw_wl.
--
-- ALL WL KEYS ARE TEXT (k_*). The `id_*` columns are WL enums, not keys, and are
-- stored as the integers they arrive as - the same split 0011 made.
--
-- FK SAFETY. uid_client points at person and k_location at location, both
-- populated by stub-upsert before the write (the pattern purchases.ts uses), so
-- a payer we have never enumerated does not fail the pass. k_purchase and
-- k_purchase_item are deliberately NOT foreign keys: the report reaches
-- transactions whose purchase the per-client path has never listed, and stubbing
-- a purchase row with no totals would put an unpriced purchase into
-- `purchase_net` and understate a month while looking clean.
--
-- Safe to re-run.
-- =============================================================================

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
-- pay_transaction - one payment, as the Payment View report states it (cid 799)
-- -----------------------------------------------------------------------------
create table if not exists public.pay_transaction (
  id                    uuid        primary key default gen_random_uuid(),
  k_business            text        not null,

  -- Identity. See the header: WL publishes no unique row key for this report.
  row_hash              text        not null,
  i_occurrence          integer     not null default 0
                        constraint pay_transaction_occurrence_check
                        check (i_occurrence >= 0),

  -- WL's transaction key. Present on every row of THIS report (0 nulls of
  -- 10,196) but not unique - 9,419 distinct values, because a transaction can
  -- surface once per purchase it paid for.
  k_pay_transaction     text        not null,
  -- No FK: the report reaches purchases the per-client path has not listed.
  k_purchase            text,

  -- dtu_ is UTC, dtl_ is local wall time. Both kept: a local time cannot be
  -- reconstructed from the UTC value, because WL's `text_timezone` is an
  -- abbreviation ("ET") that does not say whether EST or EDT applied.
  dtu_date              timestamptz,
  dtl_date              timestamp,
  -- When the purchase this payment settles was started. Lets a payment be aged
  -- against its sale - observed a 2024-04-18 purchase paid on 2025-05-13.
  dtu_purchase_start    timestamptz,

  uid_client            text        references public.person (uid) on delete restrict,
  k_location            text        references public.location (k_location) on delete set null,

  is_paid               boolean,
  -- WL's own flag for "this row is a refund", not derived from the sign.
  is_refund             boolean     not null default false,
  i_quantity            integer,

  m_amount              numeric(12, 2),
  m_sale                numeric(12, 2),
  m_net_sale            numeric(12, 2),
  m_discount_amount     numeric(12, 2),
  m_total_tax           numeric(12, 2),
  m_total_tip           numeric(12, 2),
  m_total_sale_amount   numeric(12, 2),
  m_total_amount        numeric(12, 2),
  m_total_paid          numeric(12, 2),
  m_total_receipt       numeric(12, 2),
  m_debit               numeric(12, 2),
  m_credit              numeric(12, 2),
  m_account_change      numeric(12, 2),
  m_transaction_balance numeric(12, 2),

  text_payment_method   text,
  text_method           text,
  text_comment          text,
  text_origin           text,
  text_frequency        text,
  text_status           text,
  text_decline_reason   text,
  -- Processor reconciliation. Observed "wl::71886001" in text_order_id.
  s_batch_number        text,
  text_order_id         text,
  text_processor_reference text,
  id_pay_transaction_status integer,

  -- Who took the payment. `text_actor` is "System" for a recurring charge.
  uid_actor             text,
  text_actor            text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  synced_at             timestamptz not null default now(),

  constraint pay_transaction_natkey unique (k_business, row_hash, i_occurrence)
);

create index if not exists pay_transaction_k_business_idx
  on public.pay_transaction (k_business);
create index if not exists pay_transaction_tx_idx
  on public.pay_transaction (k_pay_transaction);
create index if not exists pay_transaction_purchase_idx
  on public.pay_transaction (k_purchase);
-- The royalty question is "what happened in this month", so the date leads.
create index if not exists pay_transaction_date_idx
  on public.pay_transaction (k_business, dtu_date);

drop trigger if exists pay_transaction_set_updated_at on public.pay_transaction;
create trigger pay_transaction_set_updated_at
  before update on public.pay_transaction
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- pay_transaction_item - one item of one transaction (cid 739)
-- -----------------------------------------------------------------------------
create table if not exists public.pay_transaction_item (
  id                    uuid        primary key default gen_random_uuid(),
  k_business            text        not null,

  row_hash              text        not null,
  i_occurrence          integer     not null default 0
                        constraint pay_transaction_item_occurrence_check
                        check (i_occurrence >= 0),

  -- NULL ON 10,838 OF 10,913 ROWS. Kept because the 75 rows that carry it are
  -- the only link from an item row to a payment row, but nothing may assume it.
  k_pay_transaction     text,
  k_purchase            text,
  k_purchase_item       text,
  -- WL's polymorphic item pointer: k_id names a row in the table id_table names
  -- (251 = purchase item, 964 = account payment, both observed). Two rows of one
  -- purchase item differ here, which is why both are hashed.
  k_id                  text,
  id_table              integer,
  id_purchase_item      integer,
  k_promotion           text,

  dtu_date              timestamptz,
  dtl_date              timestamp,

  uid_client            text        references public.person (uid) on delete restrict,
  k_location            text        references public.location (k_location) on delete set null,

  -- THE LIKELIEST ROYALTY GROUPING, and it exists nowhere else in this database.
  -- Observed values: "Monthly Subscriptions", "Account Payments". The report
  -- also carries the studio's own k_tag for the category; the label is what a
  -- human recognises, so the label is what is stored.
  text_revenue_category text,
  -- The item as the report titles it, e.g. "Monthly Subscription - 45 Minutes".
  -- HASHED: twelve repeat groups differ in nothing else ("General credit" vs
  -- "Account Payment" on the same item key, date and amount).
  item_title            text,

  is_refund             boolean     not null default false,
  i_quantity            integer,

  m_amount              numeric(12, 2),
  m_sale                numeric(12, 2),
  m_net_sale            numeric(12, 2),
  m_discount_amount     numeric(12, 2),
  m_total_tax           numeric(12, 2),
  m_total_tip           numeric(12, 2),
  m_total_amount        numeric(12, 2),
  m_total_paid          numeric(12, 2),
  m_total_receipt       numeric(12, 2),
  m_debit               numeric(12, 2),
  m_credit              numeric(12, 2),
  m_account_change      numeric(12, 2),
  m_transaction_balance numeric(12, 2),

  text_discount_code    text,
  text_payment_method   text,
  text_payment_method_base text,
  text_origin           text,
  text_frequency        text,
  s_batch_number        text,
  id_pay_transaction_status integer,
  id_currency           integer,

  uid_actor             text,
  text_actor            text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  synced_at             timestamptz not null default now(),

  constraint pay_transaction_item_natkey unique (k_business, row_hash, i_occurrence)
);

create index if not exists pay_transaction_item_k_business_idx
  on public.pay_transaction_item (k_business);
create index if not exists pay_transaction_item_purchase_idx
  on public.pay_transaction_item (k_purchase);
create index if not exists pay_transaction_item_item_idx
  on public.pay_transaction_item (k_purchase_item);
create index if not exists pay_transaction_item_date_idx
  on public.pay_transaction_item (k_business, dtu_date);
create index if not exists pay_transaction_item_category_idx
  on public.pay_transaction_item (k_business, text_revenue_category);

drop trigger if exists pay_transaction_item_set_updated_at on public.pay_transaction_item;
create trigger pay_transaction_item_set_updated_at
  before update on public.pay_transaction_item
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Verification. Both tables present, each with the three timestamps, its
-- updated_at trigger and its natural-key UNIQUE - which is what keeps a re-sync
-- an upsert rather than a second copy (see 0034's header).
-- =============================================================================
select
  c.relname as table_name,
  bool_or(a.attname = 'created_at') as has_created_at,
  bool_or(a.attname = 'updated_at') as has_updated_at,
  bool_or(a.attname = 'synced_at')  as has_synced_at,
  exists (
    select 1 from pg_trigger tg
    where tg.tgrelid = c.oid and tg.tgname = c.relname || '_set_updated_at'
  ) as has_trigger,
  exists (
    select 1 from pg_constraint k
    where k.conrelid = c.oid and k.contype = 'u' and k.conname = c.relname || '_natkey'
  ) as has_natkey_unique
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in ('pay_transaction', 'pay_transaction_item')
group by c.relname, c.oid
order by c.relname;
