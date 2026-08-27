-- =============================================================================
-- 0028  The refund is a fact about the PURCHASE, and an active-client view
--
-- Two unrelated things, in one migration because both are one-column additions
-- with a view on top and neither is worth its own file.
--
-- -----------------------------------------------------------------------------
-- 1. WHY purchase.m_refund EXISTS: SUM(purchase_item.m_refund) IS WRONG
-- -----------------------------------------------------------------------------
-- Measured 27 Aug 2026 against live dev, and this is not a rounding quibble - it
-- misstates revenue by five figures.
--
-- WL's /v1/profile/purchase/list/element carries m_refund at the PURCHASE level.
-- The element call is made per ITEM, so every item of a refunded purchase comes
-- back carrying the SAME refund, and memberships.ts stored it on each one. Summing
-- the column therefore multiplies the refund by the number of items:
--
--   purchase 174396118   m_total $475.00   5 items x -$380.00 = -$1,900.00  (4x)
--   purchase 174398437   m_total $285.00   3 items x -$190.00 =   -$570.00  (2x)
--
-- THE TEST THAT SETTLES IT. Of 381 purchases carrying a refund, 52 have more than
-- one refunding item and ALL 52 carry an identical amount on every item - not one
-- case of two items differing. And "refund exceeds the purchase total", which
-- should be almost impossible:
--
--   summing over items   38 purchases, $17,303.50 of excess
--   one per purchase      3 purchases,     $63.50 of excess
--
-- A 273x reduction in the anomaly. The refund is per purchase.
--
-- WHY purchase_item.m_refund IS KEPT. It records what the element call actually
-- returned, which is the point of a raw-faithful column - deleting it would lose
-- the evidence for the paragraph above. It is now documented as an echo, and
-- nothing may SUM it.
--
-- WHY A COLUMN AND NOT ONLY A VIEW. Net revenue is the number this whole system
-- exists to produce, and it should not depend on every future reader knowing that
-- one column must be de-duplicated on the way past. The column is the answer;
-- the views below are how it is read.
--
-- -----------------------------------------------------------------------------
-- 2. WHY active_client EXISTS
-- -----------------------------------------------------------------------------
-- 0027 added person.is_active. Measured on the full 1,285 clients, 27 Aug 2026:
-- 517 active, 768 not - and the 517 agrees exactly with what the WL portal's
-- "All Clients" report calls Activated.
--
-- The view exists because filtering on the wrong thing is easy and looks right.
-- NINE client types appear BOTH active and inactive: "Cancelled Client" holds 55
-- ACTIVE clients, "Inactive Client" holds 60. Anyone reaching for
-- text_login_type to mean status would be wrong by hundreds of rows, so the
-- correct filter gets a name.
--
-- Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The purchase-level refund
-- -----------------------------------------------------------------------------
alter table public.purchase
  add column if not exists m_refund numeric(12, 2);

comment on column public.purchase.m_refund is
  'Refund against this purchase, NEGATIVE as WL sends it. THE authoritative '
  'refund: WL reports it at purchase level and the per-item column echoes it, so '
  'net revenue is m_total + m_refund on THIS table. Null when WL sent its '
  'no-refund marker "0", so "never refunded" stays distinguishable from '
  '"refunded zero".';

comment on column public.purchase_item.m_refund is
  'Refund as the element call returned it - an ECHO of purchase.m_refund, not a '
  'per-item amount. NEVER SUM THIS COLUMN. Measured 27 Aug 2026: all 52 '
  'purchases with more than one refunding item carry an identical value on every '
  'item, and summing them produced refunds up to 4x the purchase total. Kept '
  'because it records what actually arrived; read purchase.m_refund instead.';


-- -----------------------------------------------------------------------------
-- 2. Backfill, de-duplicated
-- -----------------------------------------------------------------------------
-- One distinct value per purchase means one refund. Genuinely differing values
-- are summed instead - there are none today, and a silent max() would hide the
-- day there are.
with per_purchase as (
  select k_purchase,
         count(distinct m_refund) as distinct_values,
         min(m_refund)            as single_value,
         sum(m_refund)            as summed
  from public.purchase_item
  where m_refund is not null
  group by k_purchase
)
update public.purchase p
   set m_refund = case when pp.distinct_values = 1 then pp.single_value else pp.summed end
  from per_purchase pp
 where pp.k_purchase = p.k_purchase
   and p.m_refund is distinct from
       (case when pp.distinct_values = 1 then pp.single_value else pp.summed end);

-- Partial: 381 refunded purchases out of 20,347. Indexing the other 98% would
-- serve no query.
create index if not exists purchase_refund_idx
  on public.purchase (k_business, dt_add)
  where m_refund is not null;


-- -----------------------------------------------------------------------------
-- 3. Net per purchase, in one place
-- -----------------------------------------------------------------------------
-- So no report has to remember the sign convention or which table to read.
create or replace view public.purchase_net as
  select p.k_purchase,
         p.k_business,
         p.k_location,
         p.uid_payer,
         p.uid_recipient,
         p.dt_add,
         p.m_sum,
         p.m_discount,
         p.m_tax,
         p.m_tip,
         p.m_total,
         p.m_refund,
         -- m_refund is already negative, so this ADDS. Subtracting it would give
         -- back the refund as revenue, which is the mistake the sign is meant to
         -- prevent.
         p.m_total + coalesce(p.m_refund, 0) as m_net,
         p.m_total is not null               as is_priced
  from public.purchase p;

comment on view public.purchase_net is
  'One row per purchase with net revenue derived once: m_total + m_refund, '
  'because m_refund is stored negative. is_priced says whether the receipt has '
  'been read yet - an unpriced purchase contributes null, not zero, and must not '
  'be counted as a $0 sale.';


-- -----------------------------------------------------------------------------
-- 4. The monthly reconciliation, as a query
-- -----------------------------------------------------------------------------
-- This replaces a standalone script. A reconciliation that lives in a script
-- gets re-derived slightly differently every time somebody needs it; a view is
-- the same answer for everyone.
--
-- MONTHS ARE UTC, and that is a limitation, not a choice. purchase.dt_add is UTC
-- and purchases store no local time; location.text_timezone is "ET", an
-- abbreviation that cannot say whether EST or EDT applied. So a purchase late on
-- the last day of a month can fall in the next one.
--
-- REFUNDS SIT IN THE PURCHASE'S MONTH, not the month they were issued: m_refund
-- carries no date of its own (dt_cancel is a different fact). A refund given in
-- June against a January purchase reduces January.
create or replace view public.revenue_month as
  select p.k_business,
         date_trunc('month', p.dt_add)::date          as month,
         count(*)                                     as purchases,
         count(p.m_total)                             as priced,
         sum(p.m_sum)                                 as m_sum,
         sum(p.m_discount)                            as m_discount,
         sum(p.m_tax)                                 as m_tax,
         sum(p.m_tip)                                 as m_tip,
         sum(p.m_total)                               as m_total,
         sum(p.m_refund)                              as m_refund,
         sum(p.m_total + coalesce(p.m_refund, 0))     as m_net
  from public.purchase p
  where p.dt_add is not null
  group by p.k_business, date_trunc('month', p.dt_add)
  order by p.k_business, date_trunc('month', p.dt_add);

comment on view public.revenue_month is
  'Monthly gross, refunds and net over priced purchases. purchases vs priced is '
  'the coverage caveat made unavoidable: a month with priced far below purchases '
  'is understated because the receipt sync has not reached it, not because the '
  'studio sold less. Months are UTC and refunds land in the purchase''s month - '
  'see the migration for why neither can be fixed from what WL sends.';


-- -----------------------------------------------------------------------------
-- 5. Active clients, named so nobody filters on the wrong column
-- -----------------------------------------------------------------------------
-- Same column list as the `client` view AS IT IS NOW - created_at/updated_at,
-- not first_seen_at. 0006 renamed first_seen_at to created_at across every
-- table, so copying 0001's original view definition compiles against a schema
-- that no longer exists. (It did, on the first attempt at this migration.)
create or replace view public.active_client as
  select uid, k_business, first_name, last_name, email, phone, phone_home,
         phone_work, date_of_birth, k_login_type, text_login_type, text_member,
         ghl_contact_id, ghl_match_state, is_active, created_at, updated_at,
         synced_at
  from public.person
  where is_active;

comment on view public.active_client is
  'The clients WL currently lists as Activated - 517 of 1,285, which matches the '
  'portal exactly (measured 27 Aug 2026). Same columns as the client view. Use '
  'this rather than text_login_type: NINE types appear both active and inactive, '
  'including 55 ACTIVE "Cancelled Client" rows and 60 ACTIVE "Inactive Client" '
  'rows, so the type label is not a status.';


-- -----------------------------------------------------------------------------
-- 6. A refund larger than the purchase it is against
-- -----------------------------------------------------------------------------
-- Three cases and $63.50 after de-duplication, against 38 and $17,303.50 before
-- it - which is what makes this worth surfacing rather than ignoring. If it grows,
-- either WL is reporting something we do not understand or the echo has started
-- being summed again somewhere.
create or replace view public.purchase_over_refunded as
  select p.k_purchase,
         p.k_business,
         p.dt_add,
         p.m_total,
         p.m_refund,
         p.m_total + p.m_refund as m_net
  from public.purchase p
  where p.m_refund is not null
    and p.m_total is not null
    and -p.m_refund > p.m_total;

comment on view public.purchase_over_refunded is
  'Purchases refunded for more than they charged. Expected to be tiny (3 rows, '
  '$63.50 on 27 Aug 2026) and a rising count means the per-item refund echo is '
  'being summed again somewhere.';

alter view public.purchase_net             set (security_invoker = on);
alter view public.revenue_month            set (security_invoker = on);
alter view public.active_client            set (security_invoker = on);
alter view public.purchase_over_refunded   set (security_invoker = on);
