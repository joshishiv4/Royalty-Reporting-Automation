-- =============================================================================
-- GoHighLevel match outcomes - read-only, changes nothing
--
-- Board item M05. Both outcomes here are normal and neither is an error, which
-- is exactly why they need checking: "normal" is the state that stops being
-- tested. Three of these criteria held only by accident before this file
-- existed - nothing stated the intent, so nothing would have noticed it break.
--
-- Run in the SQL editor. Every row must read PASS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A shared contact must stay possible.
--
-- Several WellnessLiving clients mapping to one GoHighLevel contact is a family
-- on one phone number: the phone search returns a single contact, so every
-- member matches it. Correct, not a collision.
--
-- The only realistic way to break this is a unique index added later on the
-- reasonable-sounding grounds that a contact id ought to identify one person.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'ghl_contact_id is NOT unique, so a family can share one contact' as label,
  count(*) as offending_indexes
from pg_indexes
where schemaname = 'public'
  and tablename  = 'person'
  and indexdef ilike '%unique%'
  and indexdef ilike '%ghl_contact_id%';

-- And the shared case produces no health issue of its own.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'no health issue is raised for clients sharing a contact' as label,
  count(*) as flagged
from (
  select ghl_contact_id
  from public.person
  where ghl_contact_id is not null
  group by ghl_contact_id
  having count(*) > 1
) shared
join public.data_health_issue h on h.record_key = shared.ghl_contact_id;

-- -----------------------------------------------------------------------------
-- 2. A client with no link is still fully visible and usable.
--
-- The failure this guards against is somebody "tidying up" a reporting view with
-- an inner join onto the contact id, which would silently drop every unmatched
-- client out of the numbers rather than showing them with an empty link.
-- -----------------------------------------------------------------------------
select
  case when unlinked_in_person = unlinked_in_journey then 'PASS' else 'FAIL' end as result,
  'every unlinked client still appears in customer_journey' as label,
  unlinked_in_person, unlinked_in_journey
from (
  select
    (select count(*) from public.person where ghl_contact_id is null)
      as unlinked_in_person,
    (select count(*) from public.customer_journey where ghl_contact_id is null)
      as unlinked_in_journey
) c;

-- No unmatched client is a hollow record - the details are their own, the link
-- is simply empty.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'unmatched clients still carry their own details' as label,
  count(*) as hollow_records
from public.person
where ghl_match_state = 'unmatched'
  and first_name is null
  and last_name is null;

-- -----------------------------------------------------------------------------
-- 3. Nothing was created in GoHighLevel to fill a gap.
--
-- Stated as a property of this database: a client may only carry a contact id if
-- the match actually resolved. A row holding an id while unmatched would mean
-- something invented the link.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'no unresolved client carries a contact id' as label,
  count(*) as invented_links
from public.person
where ghl_match_state <> 'matched'
  and ghl_contact_id is not null;

select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'no matched client is missing its contact id' as label,
  count(*) as empty_matches
from public.person
where ghl_match_state = 'matched'
  and ghl_contact_id is null;

-- -----------------------------------------------------------------------------
-- 4. The 48-hour clock, both sides of the boundary.
--
-- Synthetic, in a CTE - the live table cannot be aged on demand.
-- -----------------------------------------------------------------------------
with cases (label, state, unresolved_since, expected) as (
  values
    ('47 hours unresolved is not yet an alert',
      'ambiguous', now() - interval '47 hours', false),
    ('49 hours unresolved raises the alert',
      'ambiguous', now() - interval '49 hours', true),
    ('unmatched counts too - it is the age that escalates, not the reason',
      'unmatched', now() - interval '3 days', true),
    ('failed counts too',
      'failed',    now() - interval '3 days', true),
    -- A matched client has no clock at all, however old the row is.
    ('matched never alerts',
      'matched',   null,                       false),
    -- A row nobody has ever looked at still ages: the link has been empty since
    -- the row existed, and "we never got round to it" is the thing worth seeing.
    ('never attempted still ages',
      'unmatched', now() - interval '10 days', true)
),
derived as (
  select label, expected,
    (state <> 'matched'
      and unresolved_since is not null
      and unresolved_since < now() - interval '48 hours') as actual
  from cases
)
select case when actual = expected then 'PASS' else 'FAIL' end as result,
       label, expected, actual
from derived
order by result desc, label;

-- -----------------------------------------------------------------------------
-- 5. The clock is consistent with the state, live.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'every unresolved client has a clock, every matched one has none' as label,
  count(*) as inconsistent
from public.person
where (ghl_match_state <> 'matched' and ghl_unresolved_since is null)
   or (ghl_match_state =  'matched' and ghl_unresolved_since is not null);

-- The clock must never be newer than the last attempt: that would mean a retry
-- had pushed it forward, which is the whole failure this column exists to stop.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'no retry has reset the unresolved clock' as label,
  count(*) as reset_clocks
from public.person
where ghl_unresolved_since is not null
  and ghl_match_attempted_at is not null
  and ghl_unresolved_since > ghl_match_attempted_at;

-- -----------------------------------------------------------------------------
-- 6. The live picture. This is what the alert is firing on right now.
-- -----------------------------------------------------------------------------
select ghl_match_state,
       count(*) as clients,
       count(*) filter (
         where ghl_unresolved_since < now() - interval '48 hours'
       ) as over_48h,
       min(ghl_unresolved_since) as oldest
from public.person
group by ghl_match_state
order by clients desc;

select issue, issue_count, oldest
from public.data_health
where issue like 'ghl%' or issue like '%contact%'
order by issue_count desc;
