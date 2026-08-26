-- =============================================================================
-- 0024  raw_ghl: which client a stored GoHighLevel response was fetched for
--
-- Board item M06 asks for the raw GoHighLevel response to be stored "alongside"
-- the client record. Stored was easy; ALONGSIDE was the missing half.
--
-- raw_ghl's existing target_key is documented as the contact id for a contact
-- and the cursor for a page. A contact SEARCH is neither: it is a query by phone
-- or email that may return nobody, so there is no contact id to key it by - and
-- the searches that matter most are exactly the ones that found nothing. Without
-- this column the only way to find a person's raw response is to grep
-- request_params for their phone number, which is not a link.
--
-- person_uid rather than a foreign key: raw_ghl is an append-only record of what
-- arrived, and it must survive the person row being deleted or re-keyed. The
-- same reasoning as raw_wl.
--
-- Safe to re-run.
-- =============================================================================

alter table public.raw_ghl
  add column if not exists person_uid text;

comment on column public.raw_ghl.person_uid is
  'The WellnessLiving uid this response was fetched for. Deliberately not a '
  'foreign key: raw_ghl records what arrived and must outlive the row it was '
  'about. Null for responses not fetched on behalf of one person.';

create index if not exists raw_ghl_person_idx
  on public.raw_ghl (person_uid, fetched_at desc)
  where person_uid is not null;
