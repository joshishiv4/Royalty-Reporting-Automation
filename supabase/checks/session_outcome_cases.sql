-- =============================================================================
-- session_outcome case check - read-only, changes nothing
--
-- Board item 7.4 asks for tests covering every outcome plus "a session cancelled
-- on the same day it ran". The rule lives in SQL (a view, so it is derived in one
-- place and cannot go stale), so its tests live in SQL too. Duplicating the rule
-- into TypeScript purely to make vitest able to see it would break the very
-- criterion the view exists to satisfy - one place, not two.
--
-- Every case below is synthetic and lives inside a CTE. Nothing is written.
-- Run it in the SQL editor; every row must read PASS.
-- =============================================================================

with cases (label, is_cancelled_studio, is_cancelled_client, is_waitlisted,
            is_attended, is_no_show, dt_start_utc, expected) as (
  values
    -- The four the ticket names -------------------------------------------
    ('upcoming: date still ahead',
      false, false, false, false, false, now() + interval '3 days', 'upcoming'),
    ('attended: WL says they turned up',
      false, false, false, true,  false, now() - interval '3 days', 'attended'),
    ('missed: WL reports truancy',
      false, false, false, false, true,  now() - interval '3 days', 'missed'),
    ('studio_cancelled: the studio pulled the class',
      true,  false, false, false, false, now() - interval '3 days', 'studio_cancelled'),

    -- The case the ticket calls out explicitly ----------------------------
    -- Cancelled on the same day it ran. The date test alone would call this
    -- "missed" (it has passed, nobody checked in) and put a studio cancellation
    -- onto a student's record - the exact conflation the ticket warns about.
    ('same-day studio cancellation is NOT a miss',
      true,  false, false, false, false, now() - interval '2 hours', 'studio_cancelled'),

    -- The naming trap, both directions ------------------------------------
    ('studio cancellation outranks a client one',
      true,  true,  false, false, false, now() - interval '1 day', 'studio_cancelled'),
    ('client cancellation stays the client''s own',
      false, true,  false, false, false, now() - interval '1 day', 'client_cancelled'),

    -- Boundaries -----------------------------------------------------------
    ('waitlisted was never in the class',
      false, false, true,  false, false, now() - interval '1 day', 'waitlisted'),
    ('attendance marked EARLY still counts as attended',
      false, false, false, true,  false, now() + interval '2 days', 'attended'),
    ('happened, no verdict from WL -> unknown, which is Q9',
      false, false, false, false, false, now() - interval '3 days', 'unknown')
),
derived as (
  select
    label,
    expected,
    -- The rule under test, character for character as migration 0020 defines it.
    case
      when is_cancelled_studio then 'studio_cancelled'
      when is_cancelled_client then 'client_cancelled'
      when is_waitlisted       then 'waitlisted'
      when is_attended         then 'attended'
      when is_no_show          then 'missed'
      when dt_start_utc > now() then 'upcoming'
      else 'unknown'
    end as actual
  from cases
)
select
  case when actual = expected then 'PASS' else 'FAIL' end as result,
  label,
  expected,
  actual
from derived
order by result desc, label;

-- -----------------------------------------------------------------------------
-- And the live picture: how big is the 'unknown' bucket really?
--
-- This is Q9 as a number. A large unknown share means check-in is not used
-- consistently, and the "missed" outcome is not safe to price royalties on.
-- -----------------------------------------------------------------------------
select outcome, count(*) as bookings
from public.session_outcome
group by outcome
order by bookings desc;
