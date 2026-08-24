-- =============================================================================
-- 0013  purchase_item: membership state and the refund amount
--
-- Board item 6.2 (task 023). 0002 modelled the purchase item as the royalty row
-- and gave it price, count and identity. What it never carried is what the item
-- IS over time: a membership that is on hold, pending cancellation, or renewing,
-- and money that came back.
--
-- WHERE THIS DATA ACTUALLY COMES FROM
--   Not the purchase list. Probed live 24 Aug 2026 over 109 items,
--   /v1/profile/purchase/list returns EIGHTEEN fields and not one of them is a
--   membership or refund field. Every field below is on
--   /v1/profile/purchase/list/element (87 fields) - the endpoint the element pass
--   (task 021) already calls once per purchase item and mostly discards.
--   Recorded in WL-API-NOTES.
--
-- WHY sid_value IS HERE
--   It is the only field that says WHETHER a row is a membership at all:
--   observed "appointment" (91), "service-membership" (11), "service-limit" (6),
--   "class-period" (1). Without it the columns below are unreadable - a null
--   i_payment_period could mean "not a membership" or "a membership WL did not
--   fill", and those are different facts.
--
-- WHY m_refund IS numeric AND NULLABLE, AND WHAT "0" MEANS
--   WL sends the string "0" - not "0.00", not "" - when nothing was refunded, and
--   a real refund arrives NEGATIVE ("-280.00", "-230.00", "-70.00", "-42.50"
--   observed live). The writer reads "0" as "no refund" and leaves this null, so
--   "never refunded" and "refunded zero" stay distinguishable. Money is
--   numeric(12,2) like everywhere else; WL sends it as a string.
--
-- WHY THE HOLD AND CANCEL-PENDING COLUMNS LOOK UNUSED
--   They are, on dev: is_hold, dt_hold_start, dt_hold_end and is_cancel_pending
--   were 0/109 in the live probe. The columns are written and tested, but the
--   populated path has never been observed - task 008 carries the row to confirm
--   it. Leaving them out because dev is quiet would mean discovering the gap in
--   production, against real memberships.
--
-- WHY dl_cancel IS NOT HERE
--   It is the local-date twin of dt_cancel and was 0/109 where dt_cancel had 10.
--   Purchases store UTC only - see the conventions in ARCHITECTURE.md.
--
-- Safe to re-run: every add is `if not exists`.
-- =============================================================================

-- What kind of purchase item this is. Text, not an enum: the vocabulary is WL's
-- and undocumented, and an enum would reject a value we have not seen yet - the
-- same reasoning as purchase_payment.text_pay_method in 0002.
alter table public.purchase_item
  add column if not exists sid_value text;

comment on column public.purchase_item.sid_value is
  'WL purchase type - observed "appointment", "service-membership", '
  '"service-limit", "class-period". The only field that says whether this row is '
  'a membership, which is what makes the membership columns below readable.';

-- -----------------------------------------------------------------------------
-- Membership terms
-- -----------------------------------------------------------------------------
alter table public.purchase_item
  add column if not exists i_payment_period integer,
  add column if not exists m_period_price   numeric(12, 2);

comment on column public.purchase_item.i_payment_period is
  'How many periods the membership is paid over. Live: 11/109 items, always 1.';
comment on column public.purchase_item.m_period_price is
  'Price per payment period. Live: 96.00, 230.00, 329.00 - and 0.00 on eight '
  'items, which is why null (WL sent nothing) is not the same as zero.';

-- -----------------------------------------------------------------------------
-- Hold. NOT NULL with a default on the flag: "we have not seen a hold" and
-- "not on hold" are the same statement, and a nullable boolean invites a
-- three-way check nobody writes correctly.
-- -----------------------------------------------------------------------------
alter table public.purchase_item
  add column if not exists is_hold       boolean not null default false,
  add column if not exists dt_hold_start timestamptz,
  add column if not exists dt_hold_end   timestamptz;

comment on column public.purchase_item.is_hold is
  'Membership frozen. 0/109 on dev - written and tested, never observed live '
  '(task 008).';

-- -----------------------------------------------------------------------------
-- Cancellation. is_cancel_pending is "cancellation requested, not yet effective";
-- dt_cancel is when it happened or takes effect. They are independent - an item
-- can carry dt_cancel with nothing pending.
-- -----------------------------------------------------------------------------
alter table public.purchase_item
  add column if not exists is_cancel_pending boolean not null default false,
  add column if not exists dt_cancel         timestamptz;

comment on column public.purchase_item.is_cancel_pending is
  'Cancellation requested but not yet effective. 0/109 on dev - written and '
  'tested, never observed live (task 008).';
comment on column public.purchase_item.dt_cancel is
  'When the item was cancelled. Live: 10/109. UTC - dl_cancel, the local-date '
  'twin, is deliberately not stored (0/109, and purchases store UTC only).';

-- -----------------------------------------------------------------------------
-- Renewal
-- -----------------------------------------------------------------------------
alter table public.purchase_item
  add column if not exists is_renew boolean not null default false,
  add column if not exists i_renew  integer;

comment on column public.purchase_item.is_renew is
  'Set to auto-renew. Live: 9/109 true.';
comment on column public.purchase_item.i_renew is
  'How many times it has renewed. Live: 3/109 (1, 3, 4).';

-- -----------------------------------------------------------------------------
-- Refund
-- -----------------------------------------------------------------------------
alter table public.purchase_item
  add column if not exists m_refund numeric(12, 2);

comment on column public.purchase_item.m_refund is
  'Refund against this item, NEGATIVE as WL sends it (-280.00, -230.00, -70.00, '
  '-42.50 observed). Null when WL sent "0", its no-refund marker, so "never '
  'refunded" stays distinguishable from "refunded zero". Live: 5/109.';

-- Memberships are the rows a royalty question asks about repeatedly, and they are
-- a small minority (18 of 109). A partial index keeps that lookup cheap without
-- indexing the 91 appointment rows it would never return.
create index if not exists purchase_item_membership_idx
  on public.purchase_item (sid_value)
  where sid_value is not null and sid_value <> 'appointment';
