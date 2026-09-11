-- =============================================================================
-- 0026  ghl_contact + ghl_custom_field: what GoHighLevel said, as data
--
-- Board item M06, second half. The first half (0024) made the raw response
-- findable per client. This is the typed side: the fields and tags a client
-- record can actually be read from.
--
-- -----------------------------------------------------------------------------
-- WHY A TABLE AND NOT COLUMNS ON person
-- -----------------------------------------------------------------------------
-- person.ghl_contact_id is deliberately NOT unique (documented in 0023): a
-- family on one phone number resolves several clients to the same contact,
-- because the phone search returns one contact and every member matches it.
-- Measured 26 Aug 2026: 307 distinct contact ids across 317 matched clients.
--
-- So the fields and tags belong to the CONTACT, not to the person. Put them on
-- person and one fact is stored in N places, where a partial run can leave the
-- copies disagreeing - the exact failure the is_staff flag was rejected for,
-- "two places holding the same fact is how they come to disagree".
--
-- -----------------------------------------------------------------------------
-- WHY THE NATURAL KEY, NOT A SURROGATE uuid
-- -----------------------------------------------------------------------------
-- Every typed table here keys on the source system's own id as text - uid,
-- k_purchase, k_service, k_login_type. uuid PKs appear only where the source
-- gives no key at all: lead (a form submission), raw_wl, raw_ghl, raw_link,
-- sync_*. GoHighLevel gives one, so this table uses it.
--
-- A surrogate uuid would also need a second pointer column on person beside the
-- ghl_contact_id already there and already populated - two columns for one fact.
-- And it would HIDE a re-key rather than surface it: if GoHighLevel ever issued
-- a new id for a contact, a natural key shows up as a new row and the old one
-- goes stale in data_health, while a uuid would quietly keep pointing at a
-- contact that no longer exists.
--
-- -----------------------------------------------------------------------------
-- WHY THE AGREED FIELD LIST IS DATA, NOT SCHEMA - AND WHY THAT UNBLOCKS M06
-- -----------------------------------------------------------------------------
-- M06 sat blocked because "the agreed fields" was being modelled as columns, so
-- nothing could be built until the list arrived - and would need migrating again
-- if the list ever changed (STATUS.md, 26 Aug 2026).
--
-- It is modelled here as a row per field instead. fields keeps EVERY custom
-- field the contact carried; ghl_custom_field.is_reported says which ones may
-- appear on a client record. When the client confirms the list it is an UPDATE:
-- no migration, no backfill, no deploy. When they change their mind, likewise.
--
-- is_reported defaults to FALSE. Nothing reaches a client record until somebody
-- says it should - a half-right field on a client record gets believed.
--
-- Measured 26 Aug 2026 across all 1,098 stored searches: exactly THREE custom
-- field ids exist in this location's data, and 254 of 325 returned contacts
-- carry an empty customFields array.
--
--   ibhlYPvuAeAA3N8iJqv6  54 contacts, 5 values: DJ, PIANO, LIVE SOUND, VOICE,
--                         MUSIC PRODUCTION  (reads as programme/instrument -
--                         NOT named here, because guessing the name is the same
--                         mistake as guessing the list)
--   7NBvgQs2s08waeVnsl6J  21 contacts, 20 distinct values, 9-190 chars: free text
--   f48pVfYaewIDJl35G1X1   2 contacts, 1 distinct value, 12 chars
--
-- The names cannot be fetched: id -> name lives at
-- GET /locations/{id}/customFields, and this Private Integration Token answers
-- 401 there (contacts scope only, measured - see WL-API-NOTES.md). So name is
-- nullable and filled in by hand from the client's answer, or after the token
-- gains locations.readonly.
--
-- -----------------------------------------------------------------------------
-- FETCHED ONCE, NEVER REFRESHED - AND WHAT THAT COSTS
-- -----------------------------------------------------------------------------
-- Decided 27 Aug 2026. A client is searched in GoHighLevel exactly once. Once
-- the verdict is matched or unmatched it is final, and nothing re-reads that
-- contact afterwards. The only recurring work is NEW clients, which the daily
-- pass picks up because ghl_match_attempted_at is null for them (0022).
--
-- The enrichment therefore costs NO extra API call at all: the fields and tags
-- are parsed out of the search response the matcher already has in hand. There
-- is no second request, and no refresh cycle to schedule.
--
-- THE CONSEQUENCE, STATED PLAINLY: ghl_contact is a point-in-time snapshot, and
-- fetched_at is the date of the match, not of the data. A tag added or removed
-- in GoHighLevel after that day is not reflected here and will not be. Anything
-- that must track a live tag has to read GoHighLevel directly, which this system
-- deliberately does not do.
--
-- THE AGE IS STILL REPORTED, AND THAT IS A DELIBERATE CALL (27 Aug 2026). With
-- nothing refreshing, stale_ghl_contact is not an alarm somebody can act on: 30
-- days after a client is matched it goes red and stays red, because no run will
-- ever clear it. It is kept anyway, and knowingly, because a reader of a royalty
-- report needs to see that the GoHighLevel half of a client record is four
-- months old. The row states an age, not a fault.
--
-- Read it that way. It is NOT the never-clears trap 0023 warned about only
-- because nobody is being asked to chase it - if that ever changes, the honest
-- fix is a refresh route, not a longer interval.
--
-- missing_ghl_enrichment is the actionable companion: linked to a contact with
-- nothing stored at all. That one does clear, and closing it costs no API call.
--
-- Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The contact snapshot
-- -----------------------------------------------------------------------------
create table if not exists public.ghl_contact (
  -- GoHighLevel's own contact id, e.g. I4B54A9Du8JQZp4EPvfX. Text, like every
  -- other external key here: an opaque string that must survive verbatim.
  ghl_contact_id text        primary key,

  -- GHL scopes everything by location, and it is not the WL business id. Kept
  -- so a second location can be added without the rows becoming ambiguous.
  location_id    text        not null,

  -- Every custom field the contact carried, keyed by GHL field id:
  --   {"ibhlYPvuAeAA3N8iJqv6": "PIANO"}
  -- jsonb rather than columns because the set is the location's to change, and
  -- because a multi-select field returns an array where a text one returns a
  -- string. An empty object is the normal case - 78% of contacts.
  fields         jsonb       not null default '{}'::jsonb,

  -- The whole tag set as GoHighLevel last stated it. 44 distinct tags observed;
  -- 1-11 per contact, 2 typical.
  --
  -- REPLACE, NOT MERGE - and that is the honest default, not a shortcut. Tags
  -- carry operational state that GoHighLevel retires (mal inbox, nl stage 2,
  -- power dialer clean up). Merging would keep a tag on our record after GHL
  -- had removed it, and nothing would ever take it off again. Merge history, if
  -- it is ever wanted, is recoverable from raw_ghl - every fetch is kept - which
  -- is what makes replace a reversible decision rather than a lossy one.
  tags           text[]      not null default '{}',

  -- When GoHighLevel was last asked. This is the fetch timestamp M06 asks for.
  -- Deliberately NOT synced_at: synced_at across this schema means "last read
  -- back from WellnessLiving", and 0023 already had to fix a health view that
  -- conflated the two.
  fetched_at     timestamptz not null,

  -- Which stored response this row was parsed out of. No FK, for the same
  -- reason raw_link.table_name has none: a missing lookup must not fail the row.
  raw_ghl_id     uuid,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.ghl_contact is
  'One row per GoHighLevel CONTACT - not per person. Several clients share a '
  'contact when a family shares a phone number, so keying this by person would '
  'store one fact many times. Read through the client_ghl view, which applies '
  'the agreed field list. Contains CRM data about a client, including lifecycle '
  'tags they must never see themselves.';

comment on column public.ghl_contact.fields is
  'GHL custom field id -> value, every field the contact carried. Which of them '
  'may be shown is ghl_custom_field.is_reported, not this column: storing '
  'everything is what makes the agreed list an UPDATE instead of a migration.';

comment on column public.ghl_contact.tags is
  'The tag set as last stated by GoHighLevel, replaced whole on each fetch. '
  'Merging would leave retired tags on the record permanently; raw_ghl keeps '
  'every fetch, so replace loses nothing.';

comment on column public.ghl_contact.fetched_at is
  'When GoHighLevel was last asked about this contact. Drives '
  'data_health_issue.stale_ghl_contact and the enrichment refresh.';


-- Tag filtering is the query this table exists for - "every client tagged
-- wellness member". GIN is what makes && and @> on an array cheap.
create index if not exists ghl_contact_tags_idx
  on public.ghl_contact using gin (tags);

-- jsonb_path_ops: smaller and faster than the default for @> containment, which
-- is the only jsonb operator a field lookup needs.
create index if not exists ghl_contact_fields_idx
  on public.ghl_contact using gin (fields jsonb_path_ops);

create index if not exists ghl_contact_fetched_idx
  on public.ghl_contact (fetched_at);


-- -----------------------------------------------------------------------------
-- 2. The field catalogue - the agreed list, as rows
-- -----------------------------------------------------------------------------
create table if not exists public.ghl_custom_field (
  -- GHL's field id, e.g. ibhlYPvuAeAA3N8iJqv6.
  ghl_field_id  text        primary key,

  -- Null until somebody says what it is. The API will not tell us: the endpoint
  -- that maps id -> name is 401 for this token. A null name is honest; a guessed
  -- one would be believed.
  name          text,

  -- GHL's dataType when it becomes knowable (TEXT, SINGLE_OPTIONS, ...).
  data_type     text,

  -- THE AGREED LIST. False means the field is stored but appears on no client
  -- record. Flipping this is the whole of "confirm the field list with the
  -- client" - one UPDATE, no migration.
  is_reported   boolean     not null default false,

  -- When this id was first seen in a response. The writer registers unknown
  -- ids automatically, so this table is a live catalogue of what the location
  -- actually uses rather than a list somebody has to maintain by hand.
  first_seen_at timestamptz not null default now(),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.ghl_custom_field is
  'The GoHighLevel custom fields this location uses, and which of them may be '
  'reported. Self-populating: the sync registers any field id it has not seen. '
  'is_reported is the agreed field list - data, so confirming it costs an '
  'UPDATE rather than a migration and a backfill.';

comment on column public.ghl_custom_field.name is
  'Nullable on purpose. GET /locations/{id}/customFields answers 401 for a '
  'contacts-scope Private Integration Token, so the name arrives from the '
  'client or after the token gains locations.readonly - never from a guess.';

comment on column public.ghl_custom_field.is_reported is
  'False by default: a field is stored the moment it is seen, and shown only '
  'when somebody has said it should be. Defaulting this true would put '
  'unreviewed CRM values on a client record, and a half-right field gets '
  'believed.';

create index if not exists ghl_custom_field_reported_idx
  on public.ghl_custom_field (is_reported)
  where is_reported;


-- -----------------------------------------------------------------------------
-- 3. updated_at triggers and RLS, matching 0006 and 0010
-- -----------------------------------------------------------------------------
-- set_updated_at() is created by 0005 and again by 0006. Repeated here so this
-- file runs standalone in a SQL editor, which is how these get applied.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['ghl_contact', 'ghl_custom_field']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.set_updated_at()',
                   t || '_set_updated_at', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;

-- RLS ON, AND DELIBERATELY NO POLICY - so no authenticated user reaches these
-- rows, the same stance 0010 takes for raw_ghl and sync_*. This is not laziness
-- about the portal: the tag set includes "disqualified lead", "bad email" and
-- "no phone number", which are the studio's notes about a client and not the
-- client's to read. Reporting runs on the service role, which bypasses RLS.
--
-- Should a student-facing field ever be agreed, the policy belongs on the
-- client_ghl view's own terms and must expose only is_reported fields - never
-- ghl_contact.tags wholesale.


-- -----------------------------------------------------------------------------
-- 4. How old is too old to read without noticing
-- -----------------------------------------------------------------------------
-- stale_after() is 24 hours because the WellnessLiving sync runs daily. Reusing
-- it here would mark every enriched client stale the next morning: GoHighLevel
-- is read once per client and never again, so a day-old snapshot is exactly what
-- the design produces.
--
-- Its own function, so the two thresholds cannot be changed into each other by
-- accident, and so this number is in one place when somebody decides 30 days was
-- the wrong call.
create or replace function public.ghl_stale_after()
returns interval
language sql
immutable
as $$ select interval '30 days' $$;

comment on function public.ghl_stale_after() is
  'How old a ghl_contact snapshot may be before data_health says so. Longer than '
  'stale_after() because GoHighLevel is fetched once per client and never '
  'refreshed - so this reports an AGE for a reader to weigh, not a fault for '
  'somebody to chase. One place to change it.';


-- -----------------------------------------------------------------------------
-- 5. Which clients are linked but carry nothing
-- -----------------------------------------------------------------------------
-- The gap this design can actually have. There is deliberately no age condition
-- here (see FETCHED ONCE above): a snapshot is never refreshed, so old is not
-- wrong. Missing is.
--
-- Two ways a row lands here, and both are cleared the same way - by parsing a
-- stored raw_ghl payload, with no call to GoHighLevel:
--   * a client matched before this migration existed (all 317 of them, until
--     section 8 below runs)
--   * a match whose enrichment write failed while the match itself succeeded
create or replace view public.ghl_enrichment_missing as
  select p.uid,
         p.k_business,
         p.ghl_contact_id,
         p.ghl_match_attempted_at
  from public.person p
  where p.ghl_match_state = 'matched'
    and p.ghl_contact_id is not null
    and not exists (
      select 1 from public.ghl_contact gc
      where gc.ghl_contact_id = p.ghl_contact_id
    );

comment on view public.ghl_enrichment_missing is
  'Matched clients with no stored GoHighLevel fields or tags. No age condition '
  'on purpose - enrichment is fetched once and never refreshed, so an old '
  'snapshot is by design and only a missing one is a gap. Fixed by re-parsing '
  'raw_ghl, never by calling GoHighLevel again.';


-- -----------------------------------------------------------------------------
-- 6. data_health_issue, with enrichment age and gap both visible
--
-- Recreated in full: Postgres cannot append a branch to an existing view. This
-- is 0021's definition plus the two GoHighLevel enrichment branches at the end.
-- -----------------------------------------------------------------------------
create or replace view public.data_health_issue as
  select 'unmatched_contact'::text as issue,
         'person'::text            as table_name,
         p.uid                     as record_key,
         p.k_business,
         'no GoHighLevel contact linked'::text as detail,
         p.synced_at               as as_of
  from public.person p
  where p.ghl_match_state = 'unmatched'

  union all
  select 'ambiguous_contact', 'person', p.uid, p.k_business,
         'GoHighLevel match is ambiguous', p.synced_at
  from public.person p
  where p.ghl_match_state = 'ambiguous'

  union all
  select 'failed_contact_match', 'person', p.uid, p.k_business,
         'GoHighLevel match failed', p.synced_at
  from public.person p
  where p.ghl_match_state = 'failed'

  union all
  select 'unreviewed_session', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'session has passed and is not reviewed', s.synced_at
  from public.session s
  where not s.is_reviewed
    and s.dt_start_utc < now()
    and not s.is_cancelled_studio

  union all
  select 'unconfirmed_request', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'booking request the studio has not confirmed', s.synced_at
  from public.session s
  where s.is_request
    and not s.is_denied

  union all
  select 'denied_request', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'booking request the studio refused', s.synced_at
  from public.session s
  where s.is_denied

  union all
  select 'stale_person', 'person', p.uid, p.k_business,
         'not confirmed against WL since ' || p.synced_at::text, p.synced_at
  from public.person p
  where p.synced_at < now() - public.stale_after()

  union all
  select 'stale_purchase', 'purchase', pu.k_purchase, pu.k_business,
         'not confirmed against WL since ' || pu.synced_at::text, pu.synced_at
  from public.purchase pu
  where pu.synced_at < now() - public.stale_after()

  union all
  select 'stale_session', 'session',
         s.k_period || '|' || s.dt_start_utc::text, s.k_business,
         'not confirmed against WL since ' || s.synced_at::text, s.synced_at
  from public.session s
  where s.synced_at < now() - public.stale_after()

  union all
  select 'open_conflict', c.table_name, c.record_key, c.k_business,
         c.reason, c.created_at
  from public.sync_conflict c
  where c.resolution_state = 'open'

  union all
  select 'unprocessed_raw_wl', 'raw_wl', r.id::text, r.k_business,
         'fetched from ' || r.source_endpoint || ' and not parsed', r.fetched_at
  from public.raw_wl r
  where r.processed_at is null

  union all
  select 'failed_raw_wl', 'raw_wl', r.id::text, r.k_business,
         coalesce(r.process_error, 'parse failed'), r.fetched_at
  from public.raw_wl r
  where r.process_error is not null

  union all
  -- NEW (M06): the GoHighLevel snapshot has aged past ghl_stale_after().
  --
  -- READ THIS AS AN AGE, NOT A FAULT. Nothing refreshes enrichment, so this row
  -- appears 30 days after a client is matched and does not go away. It is here
  -- so that somebody reading a royalty report can see the GoHighLevel half of a
  -- client record is months old - not so that anybody chases it.
  --
  -- Dated from fetched_at, not synced_at - synced_at moves on every WL sync, so
  -- data_health.oldest would report the wrong age, which is the bug 0023 had to
  -- fix for the unresolved rows.
  select 'stale_ghl_contact', 'person', p.uid, p.k_business,
         'GoHighLevel fields last fetched ' || gc.fetched_at::text, gc.fetched_at
  from public.person p
  join public.ghl_contact gc on gc.ghl_contact_id = p.ghl_contact_id
  where gc.fetched_at < now() - public.ghl_stale_after()

  union all
  -- NEW (M06): linked, but nothing was ever stored. A DIFFERENT issue from both
  -- stale and unmatched. unmatched means GoHighLevel has nobody; stale means we
  -- read them a while ago; this means it has somebody and we hold nothing.
  --
  -- Unlike stale, this one is actionable and it clears - and closing it costs no
  -- API call, because the payload is already in raw_ghl.
  select 'missing_ghl_enrichment', 'person', m.uid, m.k_business,
         'linked to a GoHighLevel contact with no stored fields or tags',
         m.ghl_match_attempted_at
  from public.ghl_enrichment_missing m;

comment on view public.data_health_issue is
  'Every known soft failure, one row each, in a uniform shape. Includes the two '
  '7.5 exclusions and two M06 enrichment rows that mean different things: '
  'stale_ghl_contact states an AGE and will not clear, because nothing '
  'refreshes GoHighLevel; missing_ghl_enrichment is a real gap and does clear.';


-- -----------------------------------------------------------------------------
-- 7. The client-facing projection - the agreed list applied
-- -----------------------------------------------------------------------------
-- M06 asks for the fields "on the client record". This is that record: one row
-- per client, carrying only the fields somebody has agreed to report, under
-- their human names where a name is known. The same approach as client and
-- teacher being views - the shape without storing anything twice.
create or replace view public.client_ghl as
  select p.uid,
         p.k_business,
         p.ghl_contact_id,
         gc.fetched_at as ghl_fetched_at,
         coalesce(
           (select jsonb_object_agg(coalesce(f.name, f.ghl_field_id), v.value)
            from jsonb_each(
                   case when jsonb_typeof(gc.fields) = 'object'
                        then gc.fields else '{}'::jsonb end) as v(key, value)
            join public.ghl_custom_field f on f.ghl_field_id = v.key
            where f.is_reported),
           '{}'::jsonb
         ) as ghl_fields,
         gc.tags as ghl_tags
  from public.person p
  join public.ghl_contact gc on gc.ghl_contact_id = p.ghl_contact_id;

comment on view public.client_ghl is
  'The GoHighLevel half of a client record: agreed fields under their names, the '
  'tag set, and when it was fetched. Keyed by the client, though the row it '
  'reads is per contact - which is why a family on one phone number correctly '
  'shows the same values without the values being stored twice. Only '
  'is_reported fields appear, so narrowing or widening the agreed list is an '
  'UPDATE on ghl_custom_field.';

-- Views read person, so they must defer to the caller or they hand out
-- everything regardless of the policies in 0010. create-or-replace preserves
-- reloptions, but re-applying costs nothing and makes this file standalone.
alter view public.data_health            set (security_invoker = on);
alter view public.data_health_issue      set (security_invoker = on);
alter view public.ghl_enrichment_missing set (security_invoker = on);
alter view public.client_ghl             set (security_invoker = on);


-- -----------------------------------------------------------------------------
-- 8. Backfill from what is already stored - no call to GoHighLevel
-- -----------------------------------------------------------------------------
-- This is the promise STATUS.md made on 26 Aug 2026 being kept: "when the list
-- is confirmed the fields are parsed out of stored responses rather than
-- re-pulled from GoHighLevel. A re-parse is a query; a re-pull is hours."
--
-- It is a query. 1,098 stored searches, 325 returned contacts, 307 of them
-- distinct - every field and tag this backfill needs is already in raw_ghl, so
-- the 317 clients matched before today are enriched with ZERO API calls. That
-- is also why the fetch-once policy costs nothing to adopt retroactively.
--
-- Restricted to contacts some person is actually LINKED to. An ambiguous search
-- returned two or three contacts and none of them was chosen; storing those
-- would fill the table with contacts no client points at.
--
-- Newest fetch wins, and only if it is newer - so re-running this cannot move a
-- row backwards to an older snapshot.
with linked as (
  select distinct ghl_contact_id
  from public.person
  where ghl_match_state = 'matched'
    and ghl_contact_id is not null
),
candidate as (
  select r.id          as raw_ghl_id,
         r.location_id,
         r.fetched_at,
         c.contact
  from public.raw_ghl r
       -- The guard is INSIDE the lateral, not in a WHERE. A set-returning
       -- function in FROM is evaluated per row before WHERE filters anything, so
       -- a WHERE jsonb_typeof(...) = 'array' would not stop
       -- jsonb_array_elements being handed an object and erroring. Every stored
       -- payload measured has contacts as an array; this is for the next
       -- endpoint whose responses land in raw_ghl.
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(r.payload -> 'contacts') = 'array'
              then r.payload -> 'contacts'
              else '[]'::jsonb end) as c(contact)
  where c.contact ->> 'id' in (select ghl_contact_id from linked)
),
newest as (
  select distinct on (contact ->> 'id')
         contact ->> 'id' as ghl_contact_id,
         location_id,
         fetched_at,
         raw_ghl_id,
         contact
  from candidate
  order by contact ->> 'id', fetched_at desc
)
insert into public.ghl_contact
  (ghl_contact_id, location_id, fields, tags, fetched_at, raw_ghl_id)
select n.ghl_contact_id,
       n.location_id,
       -- customFields is an array of {id, value}; measured always present and
       -- always an array, but guarded because a re-parse must not throw on a
       -- shape GoHighLevel changes later.
       coalesce(
         (select jsonb_object_agg(f ->> 'id', f -> 'value')
          from jsonb_array_elements(
                 case when jsonb_typeof(n.contact -> 'customFields') = 'array'
                      then n.contact -> 'customFields'
                      else '[]'::jsonb end) as f
          where f ->> 'id' is not null),
         '{}'::jsonb),
       coalesce(
         (select array_agg(t)
          from jsonb_array_elements_text(
                 case when jsonb_typeof(n.contact -> 'tags') = 'array'
                      then n.contact -> 'tags'
                      else '[]'::jsonb end) as t),
         '{}'::text[]),
       n.fetched_at,
       n.raw_ghl_id
from newest n
on conflict (ghl_contact_id) do update
   set location_id = excluded.location_id,
       fields      = excluded.fields,
       tags        = excluded.tags,
       fetched_at  = excluded.fetched_at,
       raw_ghl_id  = excluded.raw_ghl_id
 where excluded.fetched_at > ghl_contact.fetched_at;


-- -----------------------------------------------------------------------------
-- 9. Register every field id now stored
-- -----------------------------------------------------------------------------
-- Derived rather than listed. The three ids measured on 26 Aug 2026 are named in
-- the header for the record, but hardcoding them here would go stale the first
-- time the location adds a field - and the sync registers unknown ids anyway, so
-- a hardcoded list would only ever be a second, wronger copy.
--
-- Names stay null and is_reported stays false: seen is not the same as agreed.
insert into public.ghl_custom_field (ghl_field_id)
select distinct k
from public.ghl_contact
     cross join lateral jsonb_object_keys(
       case when jsonb_typeof(fields) = 'object' then fields else '{}'::jsonb end) as k
on conflict (ghl_field_id) do nothing;
