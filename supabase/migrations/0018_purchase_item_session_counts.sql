-- =============================================================================
-- 0018  purchase_item: the package size and how many sessions remain
--
-- Board item 6.4. The portal shows a student "3 of 4 lessons used"; nothing in
-- the database could answer that. These fields ride on the SAME element payload
-- 0013 already reads, so this costs no additional API call.
--
-- Q14 IS RESOLVED, AND THE ANSWER IS THAT THERE WAS NEVER A CONTRADICTION
--   The open question said the session-count fields disagreed with each other on
--   a live four-session package. Measured across all 109 items:
--
--     i_left  = 0 on 109 of 109. Without exception. It is a dead field.
--     i_limit - i_use = i_remain  holds on 6 of 6 items that carry a limit.
--
--   Live packages, all consistent:
--     48 Lessons  limit 48  use 13  remain 35
--      4 Lessons  limit  4  use  3  remain  1
--      4 Lessons  limit  4  use  4  remain  0
--      8 Lessons  limit  8  use  0  remain  8
--
--   So the fields never contradicted anything. i_left was being read as
--   "sessions left" when it is not that field at all. The real answer is:
--     package size = i_limit,  used = i_use,  REMAINING = i_remain.
--
--   i_left is stored anyway, exactly as WL sends it. The ticket said to store
--   the raw values rather than reconcile them in code, and a column that is
--   always zero is evidence - dropping it would leave the next person to
--   rediscover this from scratch.
--
-- i_buy AND i_book ARE ALSO CONSTANT
--   i_buy = 1 and i_book = 0 on all 109. Stored for the same reason: measured
--   constants are a finding, guesses are not.
--
-- NO ARITHMETIC IS PERFORMED HERE
--   i_remain is stored as WL sends it, never computed from i_limit - i_use.
--   They agree today on every row measured; if WL ever disagrees with itself we
--   want to SEE that, not paper over it with a subtraction.
--
-- Safe to re-run.
-- =============================================================================

alter table public.purchase_item
  add column if not exists i_limit  integer,
  add column if not exists i_left   integer,
  add column if not exists i_remain integer,
  add column if not exists i_use    integer,
  add column if not exists i_book   integer,
  add column if not exists i_buy    integer;

comment on column public.purchase_item.i_limit is
  'Package size - how many sessions the item entitles. WL sends 0, NOT null, on '
  'an unlimited item, and 0 is stored as sent (the ticket asked for raw values). '
  'So "has a limit" is i_limit > 0, not i_limit is not null - live that is 6 of '
  '109: 4, 4, 8, 8, 12 and 48 lessons.';
comment on column public.purchase_item.i_remain is
  'Sessions REMAINING. This is the field the portal shows a student, not '
  'i_left. Stored as WL sends it, never derived from i_limit - i_use.';
comment on column public.purchase_item.i_left is
  'WL sends this as 0 on every item measured (109 of 109) - it is NOT the '
  'remaining count, despite the name. Kept as evidence so Q14 is not reopened.';
comment on column public.purchase_item.i_use is
  'Sessions used. i_limit - i_use equalled i_remain on 6 of 6 limited items.';

-- "Which packages still have sessions on them" is the question this answers, and
-- it is asked of the small minority of items that carry a limit at all.
--
-- The predicate is i_limit > 0, not "is not null". WL sends 0 for an unlimited
-- item and that 0 is stored, so a null test would index all 109 rows and index
-- nothing usefully - which is exactly what the first version of this did.
drop index if exists purchase_item_remaining_idx;
create index if not exists purchase_item_remaining_idx
  on public.purchase_item (k_business, i_remain)
  where i_limit > 0;
