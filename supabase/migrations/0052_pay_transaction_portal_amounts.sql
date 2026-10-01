-- =============================================================================
-- 0052  pay_transaction_item.m_net_sale_portal / pay_transaction.m_total_paid_portal
--       (the amount the WL portal SHOWS, beside the raw column it disagrees with)
--
-- WHY A SECOND COLUMN, NOT A DIFFERENT SOURCE FOR THE FIRST
-- -----------------------------------------------------------------------------
-- Each report row carries a money value twice: a plain column (`m_net_sale`,
-- `m_total_paid`) and an `o_*` object the portal renders the cell from
-- (`o_net_sale`, `o_total_paid`), whose `m_amount` is the number on screen. They
-- agree on almost every row. Where they do not, the portal - and its CSV export,
-- and its summary tiles - show the `o_*` value. Measured 1 Oct 2026, Accrual and
-- cash, against portal exports:
--
--   739 Item View, full history to 9 Sep 2026, 34,255 rows
--     sum m_net_sale            $5,282,282.37
--     sum o_net_sale.m_amount   $5,234,690.28   = portal "Total Net Sales", to the cent
--     differ on 110 rows, all "Account Payments" (a payment ONTO an account),
--     where the portal shows what was paid: m_net_sale $1,863.90, shown $1,346.15
--
--   799 Transaction View, 14 Sep 2020 .. 1 Oct 2026, 33,064 unique rows
--     m_total_paid = o_total_paid.m_amount on 33,048 rows
--     differ on 16, all "Account Adjustment / Account Credited" (Mar-Apr 2026):
--     m_total_paid NULL, o_total_paid.m_amount set - $11,648.40 in all, and the
--     portal's 2026 CSV shows the o_* amount on every one of them
--
-- The raw column is NOT replaced, because it is not wrong - it answers a
-- different question. An account credit moves no money in, and m_total_paid
-- says so. Which of the two a royalty is computed on is a business decision that
-- M04b has not made, and keeping both means that decision costs a query rather
-- than a reload.
--
-- Only the pair that actually differs is added. 799 has no `o_net_sale`; 739
-- does have `o_total_paid`, but its `m_amount` is null on all 34,253 unique rows,
-- so there `m_total_paid` already is the portal's figure.
--
-- NOT IN row_hash, ON PURPOSE. Rows were already stored when this was added (775
-- item / 742 payment, 1 Sep - 1 Oct 2026). Hashing the new value would give every
-- one of them a new identity and the next read would insert a second copy beside
-- it. Left out, the next read of a stored row upserts onto it and fills the new
-- column. Two rows differing ONLY in this value share a hash and are numbered by
-- i_occurrence - kept apart, not merged. src/sync/transactions.ts holds the rule.
--
-- numeric(12,2), as every money column here: WL sends "460.00" as a string.
--
-- Safe to re-run.
-- =============================================================================

alter table public.pay_transaction_item
  add column if not exists m_net_sale_portal numeric(12, 2);

alter table public.pay_transaction
  add column if not exists m_total_paid_portal numeric(12, 2);

comment on column public.pay_transaction_item.m_net_sale_portal is
  'o_net_sale.m_amount: the net sale the WL portal shows, and what its "Total '
  'Net Sales" tile sums. Differs from m_net_sale on "Account Payments" rows, '
  'where the portal shows the amount actually paid. Null until the row is next '
  're-read if it was stored before 0052. Not part of row_hash.';

comment on column public.pay_transaction.m_total_paid_portal is
  'o_total_paid.m_amount: the total paid the WL portal and its CSV show. Equals '
  'm_total_paid except on "Account Credited" adjustments, where m_total_paid is '
  'null (no money came in) and this carries the credited amount. Null until the '
  'row is next re-read if it was stored before 0052. Not part of row_hash.';
