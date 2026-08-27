-- =============================================================================
-- ghl_contact invariants - read-only, changes nothing
--
-- Board item M06. Migration 0026 made four decisions that look like tidying-up
-- candidates to anyone reading the schema cold, and every one of them would be
-- "fixed" into a bug:
--
--   * a family shares a contact, so one ghl_contact row serves several clients
--   * there is no FK from person to ghl_contact, on purpose
--   * an aged snapshot is NOT a health issue, because nothing refreshes it
--   * is_reported is false until somebody says otherwise
--
-- Run in the SQL editor. Every row must read PASS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. No orphans: every stored contact is one some client is linked to.
--
-- 0026's backfill restricts itself to linked contacts on purpose - an ambiguous
-- search returned two or three candidates and none was chosen. A row here for a
-- contact nobody points at means something started storing every candidate,
-- which quietly turns this table into a partial mirror of GoHighLevel's 22,865
-- contacts.
--
-- This is what stands in for the foreign key 0026 deliberately does not have.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'every ghl_contact row is linked from at least one person' as label,
  count(*) as orphaned_contacts
from public.ghl_contact gc
where not exists (
  select 1 from public.person p where p.ghl_contact_id = gc.ghl_contact_id
);


-- -----------------------------------------------------------------------------
-- 2. A shared contact must stay ONE row.
--
-- 307 distinct contacts across 317 matched clients, measured 26 Aug 2026 - so
-- sharing is real and normal. The failure this catches is enrichment being moved
-- onto person, or keyed per person here: the same fields would then be stored
-- once per family member, and a partial run could leave the copies disagreeing.
--
-- Expressed as: the number of ghl_contact rows may never exceed the number of
-- distinct contact ids clients are linked to.
-- -----------------------------------------------------------------------------
with linked as (
  select distinct ghl_contact_id
  from public.person
  where ghl_contact_id is not null
)
select
  case when (select count(*) from public.ghl_contact)
            <= (select count(*) from linked)
       then 'PASS' else 'FAIL' end as result,
  'one row per contact, not per person' as label,
  (select count(*) from public.ghl_contact) as contact_rows,
  (select count(*) from linked)             as distinct_linked_contacts;


-- -----------------------------------------------------------------------------
-- 3. No unique index on ghl_contact_id over on person.
--
-- Same check as ghl_match_cases.sql makes, repeated here because 0026 gives
-- somebody a fresh reason to add one: now that ghl_contact keys on the id, a
-- unique index on the person side looks like it would "complete" the
-- relationship. It would instead break every family that shares a phone number.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'person.ghl_contact_id is still NOT unique' as label,
  count(*) as offending_indexes
from pg_indexes
where schemaname = 'public'
  and tablename  = 'person'
  and indexdef ilike '%unique%'
  and indexdef ilike '%ghl_contact_id%';


-- -----------------------------------------------------------------------------
-- 4. No foreign key from person to ghl_contact.
--
-- The matcher writes person.ghl_contact_id, and the enrichment writes the
-- ghl_contact row afterwards and is allowed to fail. A hard FK would fail the
-- match itself on write order - the failure this design exists to avoid, the
-- same reasoning as service.k_service_category and raw_link.table_name.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'no FK from person.ghl_contact_id to ghl_contact' as label,
  count(*) as offending_constraints
from pg_constraint c
join pg_class      t on t.oid = c.conrelid
join pg_class      f on f.oid = c.confrelid
where c.contype = 'f'
  and t.relname = 'person'
  and f.relname = 'ghl_contact';


-- -----------------------------------------------------------------------------
-- 5. Staleness is measured against its OWN threshold, not the WL one.
--
-- stale_after() is 24 hours because the WL sync runs daily. ghl_stale_after() is
-- 30 days because GoHighLevel is read once per client and never again. Collapse
-- the two and every enriched client turns stale the morning after it was
-- matched - 317 rows of noise on day one.
--
-- The realistic way to break this is somebody tidying "two functions that both
-- return an interval" into one.
-- -----------------------------------------------------------------------------
select
  case when public.ghl_stale_after() > public.stale_after()
       then 'PASS' else 'FAIL' end as result,
  'ghl_stale_after() is its own, longer threshold' as label,
  public.stale_after()     as wl_threshold,
  public.ghl_stale_after() as ghl_threshold;


-- -----------------------------------------------------------------------------
-- 5b. What stale_ghl_contact means, written down where it will be read.
--
-- NOT A PASS/FAIL - a count, and a reminder. Nothing refreshes enrichment, so
-- this row appears 30 days after a client is matched and does not clear. That is
-- accepted (27 Aug 2026): it reports an AGE so a reader of a royalty report can
-- see how old the GoHighLevel half of a record is. Nobody should be chasing it.
--
-- If somebody starts treating it as a queue of work to clear, the answer is a
-- refresh route - not a longer interval, and not deleting the row.
-- -----------------------------------------------------------------------------
select
  'INFO' as result,
  'stale_ghl_contact states an age; it will not clear while nothing refreshes' as label,
  count(*)      as clients_with_aged_enrichment,
  min(as_of)    as oldest_fetch
from public.data_health_issue
where issue = 'stale_ghl_contact';


-- -----------------------------------------------------------------------------
-- 6. The gap that IS reported agrees with the view that fixes it.
--
-- missing_ghl_enrichment and ghl_enrichment_missing must be the same set. They
-- are defined once and read twice - one to surface the gap, one to seed the
-- re-parse that closes it - so a divergence means a client is either alerted on
-- and never fixed, or fixed silently and never counted.
-- -----------------------------------------------------------------------------
select
  case when (select count(*) from public.data_health_issue
             where issue = 'missing_ghl_enrichment')
          = (select count(*) from public.ghl_enrichment_missing)
       then 'PASS' else 'FAIL' end as result,
  'the reported gap and the fixable gap are the same set' as label,
  (select count(*) from public.data_health_issue
   where issue = 'missing_ghl_enrichment') as reported,
  (select count(*) from public.ghl_enrichment_missing) as fixable;


-- -----------------------------------------------------------------------------
-- 7. Nothing reaches a client record unless somebody agreed to it.
--
-- client_ghl projects only is_reported fields. Until the client confirms the
-- list every ghl_fields object must be empty - and the moment that stops being
-- true, it should be because a human flipped a flag, not because a default
-- changed.
-- -----------------------------------------------------------------------------
select
  case when (select count(*) from public.ghl_custom_field where is_reported) = 0
         and (select count(*) from public.client_ghl
              where ghl_fields <> '{}'::jsonb) = 0
       then 'PASS - no field agreed yet, and none is being shown'
       when (select count(*) from public.ghl_custom_field where is_reported) > 0
       then 'PASS - a field list has been agreed'
       else 'FAIL' end as result,
  'client_ghl shows agreed fields only' as label,
  (select count(*) from public.ghl_custom_field where is_reported) as reported_fields,
  (select count(*) from public.client_ghl where ghl_fields <> '{}'::jsonb) as clients_showing_fields;


-- -----------------------------------------------------------------------------
-- 8. Every stored field id is in the catalogue.
--
-- The catalogue is what makes the agreed list an UPDATE rather than a migration,
-- and it can only serve that if it lists what is actually stored. A field id in
-- ghl_contact.fields with no ghl_custom_field row can never be reported, because
-- client_ghl joins through the catalogue - so it would be invisible rather than
-- merely unagreed.
-- -----------------------------------------------------------------------------
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'every field id in ghl_contact.fields is registered' as label,
  count(*) as unregistered_field_ids
from (
  select distinct k
  from public.ghl_contact, jsonb_object_keys(fields) as k
) seen
where not exists (
  select 1 from public.ghl_custom_field f where f.ghl_field_id = seen.k
);


-- -----------------------------------------------------------------------------
-- 9. RLS is on and no policy lets a student read CRM tags.
--
-- The tag set includes 'disqualified lead', 'bad email' and 'no phone number' -
-- the studio's notes about a client, not the client's to read. Absence of a
-- policy is what denies access, so a policy appearing here is the whole failure.
-- -----------------------------------------------------------------------------
select
  case when bool_and(c.relrowsecurity)
        and (select count(*) from pg_policies
             where schemaname = 'public'
               and tablename in ('ghl_contact', 'ghl_custom_field')) = 0
       then 'PASS' else 'FAIL' end as result,
  'RLS on, and deliberately no policy on either table' as label,
  bool_and(c.relrowsecurity) as rls_enabled,
  (select count(*) from pg_policies
   where schemaname = 'public'
     and tablename in ('ghl_contact', 'ghl_custom_field')) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('ghl_contact', 'ghl_custom_field');
