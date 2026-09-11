-- =============================================================================
-- 0008  raw_wl / raw_ghl  - the original responses, kept
--
-- WHY THIS IS WORTH THE DISK. Several WL fields are still not understood: the
-- session-count fields and prepaid credit both have open questions. Keeping the
-- original response beside the typed columns means a field decoded wrongly today
-- is re-derived from what we already have, instead of re-pulling thousands of
-- records from an API we do not control.
--
-- The numbers make that concrete. One client had 27 purchases and each receipt is
-- its own call, so the money for 47 clients is roughly 1,270 requests. GHL holds
-- 22,865 contacts. A re-pull is hours; a re-parse is a query.
--
-- TWO TABLES, NOT ONE. WL and GHL disagree about almost everything that matters
-- here: WL answers HTTP 200 for errors and puts its own status in the body, and
-- sends a trace id on only some endpoints; GHL uses real HTTP status codes and
-- returns a traceId on every response. A single table would need both sets of
-- columns half-empty, and "which shape is this row" would be a runtime question.
--
-- ONE ROW PER FETCH, NOT PER RECORD. A list endpoint returns a page; a record
-- endpoint returns one record. Both are one fetch, and one fetch is one row -
-- storing 100 rows for a 100-contact page would multiply the payload by a
-- hundred. target_kind says which shape target_key holds.
--
-- THIS IS THE MOST SENSITIVE TABLE IN THE DATABASE. A raw payload contains
-- everything WL and GHL sent: names, emails, phones, addresses, dates of birth.
-- The typed tables hold a chosen subset; these hold the lot. RLS is on, and
-- retention is a real decision rather than an afterthought - see the note at the
-- bottom.
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- raw_wl - WellnessLiving responses, verbatim
-- -----------------------------------------------------------------------------
create table if not exists public.raw_wl (
  id               uuid        primary key default gen_random_uuid(),
  k_business       text        not null,

  -- Path only, never the host: the host is configuration and does not belong in
  -- a stored record any more than in a log line. e.g. '/v1/purchase/receipt'.
  source_endpoint  text        not null,

  -- WHAT this fetch was about. For a record endpoint the record key
  -- ('33793232', '143051749'); for a list endpoint the page cursor or date.
  -- Composite targets are joined with '|' by the writer.
  target_key       text,
  -- Which of those it is, so nothing has to guess: 'record' | 'page' | 'whole'.
  target_kind      text        not null default 'record'
    constraint raw_wl_target_kind_check
    check (target_kind in ('record', 'page', 'whole')),
  -- The query WL was actually sent. Without it the same endpoint and key can
  -- mean two different requests, and the payload becomes uninterpretable.
  request_params   jsonb       not null default '{}'::jsonb,

  -- The response, exactly as it arrived.
  payload          jsonb       not null,

  -- WHEN. The whole point of the table is being able to say "this is what they
  -- said at this moment".
  fetched_at       timestamptz not null default now(),

  http_status      integer,
  -- WL's own status field, which is where success actually lives - a 200 with
  -- status 'id-empty' is a failure (see src/wl/client.ts).
  wl_status        text,
  -- Ours, always present. Joins to sync_run and to the log line.
  trace_id         text,
  -- WL's, present only on the endpoints that send one.
  k_log            text,
  run_id           text,
  latency_ms       integer,

  -- ---------------------------------------------------------------------------
  -- Processing state. NULL means nothing has read this row yet, which is what
  -- makes the "unprocessed" query a partial index scan rather than a table scan.
  -- ---------------------------------------------------------------------------
  processed_at     timestamptz,
  processed_by_run_id text,
  -- Set when parsing was attempted and failed, so a bad payload is visible
  -- rather than silently stuck at unprocessed forever.
  process_error    text,
  -- Bumped by the writer when the parser changes, so a re-parse can find rows
  -- decoded by an older version.
  parser_version   integer     not null default 1,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.raw_wl is
  'WellnessLiving responses kept verbatim, so a field decoded wrongly can be '
  're-derived without re-pulling from a rate-limited API. Contains full PII.';
comment on column public.raw_wl.request_params is
  'The query actually sent. Without it the same endpoint and key can describe '
  'two different requests and the payload cannot be interpreted.';
comment on column public.raw_wl.processed_at is
  'NULL means unprocessed. The partial indexes below make that query cheap.';

-- THE unprocessed query, and the reason it is cheap: the index only contains
-- rows that are actually outstanding, so it shrinks as work is done.
create index if not exists raw_wl_unprocessed_idx
  on public.raw_wl (fetched_at)
  where processed_at is null;
-- Unprocessed, narrowed to one endpoint - how a worker claims its own kind.
create index if not exists raw_wl_unprocessed_endpoint_idx
  on public.raw_wl (source_endpoint, fetched_at)
  where processed_at is null;
-- Rows that failed to parse.
create index if not exists raw_wl_failed_idx on public.raw_wl (fetched_at)
  where process_error is not null;
-- Re-parse after a parser change.
create index if not exists raw_wl_parser_version_idx
  on public.raw_wl (parser_version, fetched_at);

create index if not exists raw_wl_target_idx
  on public.raw_wl (source_endpoint, target_key, fetched_at desc);
create index if not exists raw_wl_run_idx on public.raw_wl (run_id);
create index if not exists raw_wl_trace_idx on public.raw_wl (trace_id);
create index if not exists raw_wl_business_fetched_idx
  on public.raw_wl (k_business, fetched_at desc);

-- -----------------------------------------------------------------------------
-- raw_ghl - GoHighLevel responses, verbatim
-- -----------------------------------------------------------------------------
create table if not exists public.raw_ghl (
  id               uuid        primary key default gen_random_uuid(),
  -- GHL scopes everything by location, and it is not the WL business id.
  location_id      text        not null,

  source_endpoint  text        not null,

  -- For contacts this is the contact id; for a page it is the cursor. GHL pages
  -- with startAfter + startAfterId rather than a page number, so a page target
  -- is the pair, joined with '|'.
  target_key       text,
  target_kind      text        not null default 'record'
    constraint raw_ghl_target_kind_check
    check (target_kind in ('record', 'page', 'whole')),
  request_params   jsonb       not null default '{}'::jsonb,

  payload          jsonb       not null,
  fetched_at       timestamptz not null default now(),

  -- GHL uses real HTTP status codes, so unlike WL this is the outcome.
  http_status      integer,
  -- Ours.
  trace_id         text,
  -- GHL's own, returned on EVERY response as a UUID - unlike WL's k_log.
  ghl_trace_id     text,
  run_id           text,
  latency_ms       integer,

  processed_at     timestamptz,
  processed_by_run_id text,
  process_error    text,
  parser_version   integer     not null default 1,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.raw_ghl is
  'GoHighLevel responses kept verbatim. 22,865 contacts as of Aug 2026, so a '
  're-pull is hours and a re-parse is a query. Contains full PII.';
comment on column public.raw_ghl.ghl_trace_id is
  'GHL returns a traceId on every response, unlike WL which sends k_log on only '
  'some endpoints. Quote it when raising a GHL support ticket.';

create index if not exists raw_ghl_unprocessed_idx
  on public.raw_ghl (fetched_at)
  where processed_at is null;
create index if not exists raw_ghl_unprocessed_endpoint_idx
  on public.raw_ghl (source_endpoint, fetched_at)
  where processed_at is null;
create index if not exists raw_ghl_failed_idx on public.raw_ghl (fetched_at)
  where process_error is not null;
create index if not exists raw_ghl_parser_version_idx
  on public.raw_ghl (parser_version, fetched_at);

create index if not exists raw_ghl_target_idx
  on public.raw_ghl (source_endpoint, target_key, fetched_at desc);
create index if not exists raw_ghl_run_idx on public.raw_ghl (run_id);
create index if not exists raw_ghl_location_fetched_idx
  on public.raw_ghl (location_id, fetched_at desc);

-- -----------------------------------------------------------------------------
-- Traceability: every synced row points back at the fetch it came from
-- -----------------------------------------------------------------------------
-- This is the criterion the rest of the table is in service of. Without a column
-- on each typed table, "where did this value come from" is answered by matching
-- keys and timestamps by hand, which is guesswork wearing a query.
--
-- ON DELETE SET NULL, not CASCADE: if a raw payload is ever aged out, the typed
-- row must survive. Losing the provenance is acceptable; losing the royalty row
-- is not.
--
-- person carries TWO, because a person is assembled from both sides: raw_wl_id
-- for the WL record, raw_ghl_id for the GoHighLevel contact it was matched to.
do $$
declare
  t text;
begin
  foreach t in array array[
    'person', 'lead',
    'purchase', 'purchase_item', 'purchase_payment', 'purchase_account_credit',
    'service', 'location',
    'session', 'session_staff', 'attendance'
  ]
  loop
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      raise notice 'skipped % - table does not exist yet', t;
      continue;
    end if;

    execute format(
      'alter table public.%I add column if not exists raw_wl_id uuid
         references public.raw_wl (id) on delete set null', t);
    execute format(
      'create index if not exists %I on public.%I (raw_wl_id)',
      t || '_raw_wl_idx', t);
  end loop;

  -- The GoHighLevel side only reaches person and lead - nothing else is matched.
  foreach t in array array['person', 'lead']
  loop
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      continue;
    end if;
    execute format(
      'alter table public.%I add column if not exists raw_ghl_id uuid
         references public.raw_ghl (id) on delete set null', t);
    execute format(
      'create index if not exists %I on public.%I (raw_ghl_id)',
      t || '_raw_ghl_idx', t);
  end loop;

  raise notice 'provenance columns added';
end
$$;

-- -----------------------------------------------------------------------------
-- Triggers and RLS
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['raw_wl', 'raw_ghl']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.set_updated_at()',
                   t || '_set_updated_at', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
  raise notice 'raw payload tables ready';
end
$$;

-- =============================================================================
-- RETENTION IS AN OPEN DECISION, DELIBERATELY NOT MADE HERE
--
-- These two tables will outgrow every other table combined, and they hold the
-- most personal data in the database. Both facts argue for a retention policy,
-- and neither says what it should be - that is a business and privacy call, not
-- a schema one.
--
-- What the schema does provide: fetched_at to age on, processed_at to know what
-- is safe to drop, and ON DELETE SET NULL on every provenance column so ageing a
-- payload out never takes a royalty row with it.
--
-- Worth deciding before the first full backfill, not after.
-- =============================================================================

-- Verification. Expect two rows for the raw tables, then the provenance columns.
select
  c.relname as table_name,
  bool_or(a.attname = 'payload')    as has_payload,
  bool_or(a.attname = 'fetched_at') as has_fetched_at,
  bool_or(a.attname = 'processed_at') as has_processed_at,
  c.relrowsecurity as rls_on
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public' and c.relname in ('raw_wl', 'raw_ghl')
group by c.relname, c.oid, c.relrowsecurity
order by c.relname;

select table_name,
       bool_or(column_name = 'raw_wl_id')  as traces_to_wl,
       bool_or(column_name = 'raw_ghl_id') as traces_to_ghl
from information_schema.columns
where table_schema = 'public'
  and table_name in ('person', 'lead', 'purchase', 'purchase_item',
                     'purchase_payment', 'purchase_account_credit',
                     'service', 'location', 'session', 'session_staff', 'attendance')
group by table_name
order by table_name;
