-- =============================================================================
-- 0002  purchase / purchase_item / payment / account credit / service
--
-- THE ITEM IS THE ROW, NOT THE PURCHASE. One WellnessLiving purchase carries
-- several items: verified live, k_purchase 143051749 holds k_purchase_item
-- 147785701, and /v1/profile/purchase/list returns 27 purchases for a single
-- client. Keying on k_purchase would collapse the items and lose the per-item
-- price a royalty is calculated from.
--
-- MONEY ARRIVES AS STRINGS. Observed verbatim from /v1/purchase/receipt:
--   a_price = {"m_discount":"0.00","m_sum":"280.00","m_tax":"0.00",
--              "m_tip":"0.00","m_total":"280.00","text_currency":"usd"}
-- Every one is a quoted string. They are stored as numeric(12,2) - fixed
-- precision, two decimal places. Never float: 0.1 + 0.2 is not 0.3, and a
-- royalty percentage of a rounding error is a support ticket.
--
-- PREPAID CREDIT IS A SEPARATE FACT. The same receipt showed:
--   a_pay_method   = [{"m_amount":"280.00","text_pay_method":"Account"}]
--   a_account_rest = [{"m_amount":"-700.00","text_method":"Account Balance"}]
-- The payment was drawn from account credit, and the remaining balance is its
-- own line. Both are arrays, so both are child tables - a purchase can be split
-- across card, cash and account in one transaction.
--
-- TIMES ARE UTC, AND ONLY UTC. WL sends both: dt_* is UTC and dtl_* is local -
-- confirmed on this purchase, dt_add "2023-07-03 17:12:31" against
-- dtl_purchase "2023-07-03 13:12:31", exactly four hours apart.
--
-- Only the UTC value is stored, as timestamptz. A purchase is an INSTANT, and an
-- instant is fully described by UTC - "when did the money move" has one answer
-- wherever it is read. One column means two values can never disagree.
--
-- Scheduled sessions are different and DO store local time - see 0004. A class
-- at "Tuesday 6pm" stays 6pm across a daylight-saving change while its UTC value
-- shifts, and WL's timezone label is an abbreviation ("ET") that cannot be used
-- to convert anyway.
--
-- The WL local value is deliberately NOT kept. If a discrepancy against WL's own
-- local rendering ever shows up, revisit this - the raw dtl_* is one API call
-- away and nothing here would need restructuring.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- location - the studio, and the timezone every local rendering comes from
-- -----------------------------------------------------------------------------
-- Times are stored in UTC everywhere. This is the ONE place a timezone lives,
-- so a local rendering is derived from a single source rather than copied onto
-- every row. Observed: /v1/location/list returns one location for this business
-- (k_location 244238), and the schedule endpoints return text_timezone with it.
create table if not exists public.location (
  k_location       text        primary key,
  k_business       text        not null,
  title            text,
  -- As WL sends it. NOT an IANA name: observed value is "ET", an abbreviation
  -- that does not say whether EST or EDT applied and cannot be used to convert.
  -- Kept for display and for reconciling against WL. Sessions therefore store
  -- their local time rather than deriving it - see 0004.
  text_timezone    text,
  synced_at        timestamptz not null default now()
);

create index if not exists location_k_business_idx on public.location (k_business);

-- -----------------------------------------------------------------------------
-- service - what was sold
-- -----------------------------------------------------------------------------
create table if not exists public.service (
  k_service        text        primary key,
  k_business       text        not null,
  title            text,
  id_program       integer,
  id_sale          integer,
  is_package       boolean     not null default false,
  synced_at        timestamptz not null default now()
);

comment on column public.service.id_program is
  'WL program classification, e.g. 12 on the observed subscription item.';

create index if not exists service_k_business_idx on public.service (k_business);

-- -----------------------------------------------------------------------------
-- purchase - the transaction envelope
-- -----------------------------------------------------------------------------
create table if not exists public.purchase (
  k_purchase       text        primary key,
  k_business       text        not null,
  k_location       text        references public.location (k_location) on delete set null,

  -- PAYER AND RECIPIENT ARE DIFFERENT PEOPLE. A parent buys lessons for a
  -- child; the money is the parent's, the service is the child's. Royalty
  -- attribution follows the recipient, revenue reporting follows the payer, so
  -- collapsing them into one uid loses whichever question is asked second.
  uid_payer        text        references public.person (uid) on delete restrict,
  uid_recipient    text        references public.person (uid) on delete restrict,

  -- The payer's details as printed on the receipt (a_customer). Kept because WL
  -- returns them WITHOUT a uid, so this is the only record of who was billed
  -- when the payer is not a client in our own table.
  payer_name       text,
  payer_email      varchar(255),
  payer_phone      varchar(32),

  -- Receipt totals. a_price, cast from WL's strings.
  m_sum            numeric(12, 2),
  m_discount       numeric(12, 2),
  m_tax            numeric(12, 2),
  m_tip            numeric(12, 2),
  m_total          numeric(12, 2),
  -- WL sends "usd" lowercase; stored as sent, upper-cased at read time if needed.
  text_currency    text,

  -- Human-facing receipt number, e.g. "000143051749". Not the key: it is padded
  -- display text and WL is free to change the padding.
  text_purchase_id text,

  -- UTC. Local is derived from location.text_timezone when displayed.
  dt_add           timestamptz,

  is_active        boolean     not null default true,

  first_seen_at    timestamptz not null default now(),
  synced_at        timestamptz not null default now()
);

create index if not exists purchase_payer_idx on public.purchase (uid_payer);
create index if not exists purchase_recipient_idx on public.purchase (uid_recipient);
create index if not exists purchase_dt_add_idx on public.purchase (dt_add);
create index if not exists purchase_business_idx on public.purchase (k_business);

-- -----------------------------------------------------------------------------
-- purchase_item - THE unique row for royalty
-- -----------------------------------------------------------------------------
create table if not exists public.purchase_item (
  k_purchase_item  text        primary key,
  k_purchase       text        not null
                   references public.purchase (k_purchase) on delete cascade,
  k_business       text        not null,

  k_service        text        references public.service (k_service) on delete set null,
  -- WL's own item identity, distinct from k_purchase_item. Observed: k_id
  -- "1396081" against k_purchase_item 147785701.
  k_id             text,
  k_code           text,
  k_appointment    text,
  k_login_promotion text,

  text_title       text,
  text_category    text,

  m_price_total    numeric(12, 2),
  text_currency    text,
  i_count          integer     not null default 1
                   constraint purchase_item_count_check check (i_count >= 0),

  id_purchase_item integer,
  id_program       integer,
  id_sale          integer,
  is_active        boolean     not null default true,

  dt_add           timestamptz,

  first_seen_at    timestamptz not null default now(),
  synced_at        timestamptz not null default now()
);

comment on table public.purchase_item is
  'The unique row for royalty. One purchase holds several items, so keying on '
  'k_purchase would collapse them and lose the per-item price.';

create index if not exists purchase_item_purchase_idx on public.purchase_item (k_purchase);
create index if not exists purchase_item_service_idx on public.purchase_item (k_service);
create index if not exists purchase_item_dt_add_idx on public.purchase_item (dt_add);

-- -----------------------------------------------------------------------------
-- purchase_payment - the payment-method breakdown (a_pay_method)
-- -----------------------------------------------------------------------------
-- An ARRAY on the receipt, so a row each: one purchase may be settled part on a
-- card and part from account credit, and a single "paid with" column could not
-- say so.
create table if not exists public.purchase_payment (
  id               uuid        primary key default gen_random_uuid(),
  k_purchase       text        not null
                   references public.purchase (k_purchase) on delete cascade,

  -- WL's label, e.g. "Account", "Visa", "Cash". Text because the vocabulary is
  -- WL's and undocumented - an enum here would reject a method we have not seen.
  text_pay_method  text        not null,
  m_amount         numeric(12, 2) not null,
  text_currency    text,

  -- Card detail when the method was a card. a_card was [] on the account-paid
  -- receipt observed.
  card_last_four   varchar(4),
  card_brand       text,

  synced_at        timestamptz not null default now()
);

create index if not exists purchase_payment_purchase_idx
  on public.purchase_payment (k_purchase);

-- -----------------------------------------------------------------------------
-- purchase_account_credit - prepaid balance movement (a_account_rest)
-- -----------------------------------------------------------------------------
-- Observed as {"m_amount":"-700.00","text_method":"Account Balance"} alongside a
-- 280.00 payment. Negative is a balance, not a payment, which is exactly why it
-- is not folded into purchase_payment: summing the two would misstate revenue.
create table if not exists public.purchase_account_credit (
  id               uuid        primary key default gen_random_uuid(),
  k_purchase       text        not null
                   references public.purchase (k_purchase) on delete cascade,

  text_method      text,
  m_amount         numeric(12, 2) not null,
  text_currency    text,

  synced_at        timestamptz not null default now()
);

create index if not exists purchase_account_credit_purchase_idx
  on public.purchase_account_credit (k_purchase);

alter table public.location                enable row level security;
alter table public.service                 enable row level security;
alter table public.purchase                enable row level security;
alter table public.purchase_item           enable row level security;
alter table public.purchase_payment        enable row level security;
alter table public.purchase_account_credit enable row level security;
