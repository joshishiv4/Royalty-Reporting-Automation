-- =============================================================================
-- 0007  sync_queue / sync_job_state / sync_run / sync_conflict
--
-- The control plane. Without these four tables a crashed run has no way to
-- resume and no way to prove what it did.
--
-- IT MUST SURVIVE THE PROCESS DYING. A Vercel function is capped at 60s while
-- the daily sync is budgeted at two hours, so the run WILL be cut off mid-way as
-- a matter of routine, not as a failure. Everything needed to carry on has to be
-- in the database, not in memory:
--
--   sync_queue       what work is outstanding, and when to try it again
--   sync_job_state   where each job's cursor got to
--   sync_run         what every run actually did
--   sync_conflict    what a human needs to look at
--
-- ABSOLUTE TIMES, NOT DURATIONS. The queue stores next_attempt_at as a
-- timestamp, not "retry in 5 minutes". A duration only means something relative
-- to a process that is still alive; a timestamp is still correct after a crash,
-- a redeploy, or a fortnight in the queue. The retry ladder in src/wl/retry.ts
-- produces requeueAfterMs, and the writer turns it into now() + that.
--
-- RUN IDS COME FROM THE CODE. sync_run.run_id is the same eight-hex id that
-- src/wl/trace.ts generates and every log line already carries, so a line in
-- app.log joins straight to its row here. Nothing needs correlating by timestamp.
-- =============================================================================

-- Shared by all four tables. Idempotent, so this file stands alone.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- sync_queue - outstanding work
-- -----------------------------------------------------------------------------
create table if not exists public.sync_queue (
  id               uuid        primary key default gen_random_uuid(),

  -- What kind of work, and which record. Deliberately generic text rather than
  -- an enum: a new work type should be a row, not a migration.
  work_type        text        not null,
  -- The record this item is about: a uid, a k_purchase, a k_period plus date.
  -- Composite targets are joined with '|' by the writer so this stays one column.
  target_key       text        not null,
  k_business       text        not null,

  state            text        not null default 'pending'
    constraint sync_queue_state_check
    check (state in ('pending', 'in_progress', 'done', 'failed', 'dead')),

  -- attempt_count counts ATTEMPTS, so it starts at 0 and the first try makes it
  -- 1. The retry ladder is 1 / 5 / 25 minutes (src/wl/retry.ts), and when it is
  -- exhausted the item goes to 'dead' rather than being retried forever.
  attempt_count    integer     not null default 0
                   constraint sync_queue_attempt_check check (attempt_count >= 0),
  -- Absolute, so it survives the process. Now means "eligible immediately".
  next_attempt_at  timestamptz not null default now(),

  -- ---------------------------------------------------------------------------
  -- Why it last failed. These mirror WlErrorDetails so a queue row carries
  -- everything a support ticket needs without going back to the log.
  -- ---------------------------------------------------------------------------
  last_error       text,
  -- WL's machine-readable code from a_error[].sid.
  last_error_sid   text,
  last_http_status integer,
  -- Ours, always present. Joins to sync_run and to the log line.
  last_trace_id    text,
  -- WL's, present only on the endpoints that send one.
  last_k_log       text,

  -- ---------------------------------------------------------------------------
  -- Lease, so a worker that dies does not strand its item forever. A claim is
  -- only respected until claim_expires_at; after that another worker may take
  -- it. Without this, 'in_progress' would be a permanent state after a crash.
  -- ---------------------------------------------------------------------------
  claimed_by       text,
  claimed_at       timestamptz,
  claim_expires_at timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.sync_queue is
  'Outstanding work. next_attempt_at is absolute so it stays correct across a '
  'crash; the claim lease stops a dead worker stranding an item in in_progress.';

-- One ACTIVE item per target. Partial rather than a plain unique constraint, so
-- the same record can be queued again tomorrow once today's item is done.
create unique index if not exists sync_queue_active_target_key
  on public.sync_queue (work_type, target_key, k_business)
  where state in ('pending', 'in_progress');

-- The claim query: eligible work, oldest first.
create index if not exists sync_queue_claimable_idx
  on public.sync_queue (next_attempt_at)
  where state = 'pending';
-- Finding stranded claims.
create index if not exists sync_queue_expired_claims_idx
  on public.sync_queue (claim_expires_at)
  where state = 'in_progress';
create index if not exists sync_queue_dead_idx on public.sync_queue (k_business)
  where state in ('failed', 'dead');

-- -----------------------------------------------------------------------------
-- sync_job_state - where each job got to
-- -----------------------------------------------------------------------------
-- One row per job, updated in place. This is the cursor: the answer to "if I
-- start now, where do I begin".
create table if not exists public.sync_job_state (
  job_name         text        not null,
  k_business       text        not null,

  -- Cursor. Which of these is meaningful depends on the job, so all are
  -- nullable: a paged endpoint uses page_number, a keyset walk uses last_key,
  -- an incremental pull uses last_seen_at.
  page_number      integer     not null default 0
                   constraint sync_job_state_page_check check (page_number >= 0),
  last_key         text,
  last_seen_at     timestamptz,

  -- ---------------------------------------------------------------------------
  -- Resuming a part-finished REPORT. /v1/report/data is not addressed by a
  -- record key - it needs the handle WL issued for that particular report plus
  -- the page reached inside it. Both are stored, and the handle expires, so
  -- report_handle_expires_at says whether resuming is still possible or the
  -- report has to be requested afresh.
  -- ---------------------------------------------------------------------------
  report_handle    text,
  report_page      integer     constraint sync_job_state_report_page_check
                   check (report_page is null or report_page >= 0),
  report_handle_expires_at timestamptz,

  -- The last time this job finished with nothing outstanding. This is the
  -- watermark an incremental sync trusts: a run that ended half-done must NOT
  -- move it, or the next run will skip whatever it missed.
  last_clean_completion_at timestamptz,

  state            text        not null default 'idle'
    constraint sync_job_state_state_check
    check (state in ('idle', 'running', 'paused', 'failed')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint sync_job_state_pkey primary key (job_name, k_business)
);

comment on column public.sync_job_state.last_clean_completion_at is
  'Only moved when a run finished with nothing outstanding. A half-done run must '
  'leave it alone, or the next incremental pass silently skips the gap.';
comment on column public.sync_job_state.report_handle is
  'WL report handle, needed with report_page to resume a part-finished report. '
  'Handles expire - see report_handle_expires_at before trusting it.';

-- -----------------------------------------------------------------------------
-- sync_run - what each run did
-- -----------------------------------------------------------------------------
create table if not exists public.sync_run (
  -- The eight-hex id from src/wl/trace.ts. Every log line for this run carries
  -- it as the prefix of its traceId, so log and row join directly.
  run_id           text        primary key,
  job_name         text        not null,
  k_business       text        not null,

  started_at       timestamptz not null default now(),
  finished_at      timestamptz,

  -- 'partial' is a first-class outcome, not a failure: the budget running out
  -- is the normal way a run ends. Collapsing it into ok or failed would either
  -- hide unfinished work or cry wolf every single night.
  state            text        not null default 'running'
    constraint sync_run_state_check
    check (state in ('running', 'ok', 'partial', 'failed', 'cancelled')),

  pages_done       integer     not null default 0,
  rows_fetched     integer     not null default 0,
  rows_new         integer     not null default 0,
  rows_updated     integer     not null default 0,
  rows_failed      integer     not null default 0,
  constraint sync_run_counts_check check (
    pages_done >= 0 and rows_fetched >= 0 and rows_new >= 0
    and rows_updated >= 0 and rows_failed >= 0
  ),

  -- What the batch runner could not start before the budget ran out. Recorded
  -- because a summary that looks complete when it is not is worse than one that
  -- admits it ran out of time.
  items_remaining  integer     not null default 0,

  error            text,
  -- Set only when the run stopped because of one specific failure.
  error_trace_id   text,

  -- How many times a WL token was actually fetched. Should be 1 for a short
  -- pass; more than that means the shared cache is not being shared.
  token_fetches    integer,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A finished run must say when, and a running one must not.
  constraint sync_run_finished_together check (
    (state = 'running') = (finished_at is null)
  )
);

comment on column public.sync_run.run_id is
  'Same id as src/wl/trace.ts generates, and the prefix of every traceId in the '
  'log for this run. Joins the log to the database with no timestamp guessing.';

create index if not exists sync_run_job_started_idx
  on public.sync_run (job_name, started_at desc);
create index if not exists sync_run_unfinished_idx on public.sync_run (started_at)
  where state = 'running';
create index if not exists sync_run_bad_idx on public.sync_run (started_at desc)
  where state in ('failed', 'partial');

-- -----------------------------------------------------------------------------
-- sync_conflict - what a human has to decide
-- -----------------------------------------------------------------------------
-- Not everything wrong is retryable. Two clients with the same email, a
-- GoHighLevel contact matching two people, a purchase whose recipient is not a
-- client we know: no amount of retrying settles those. They are parked here with
-- the values that disagree, so the decision can be made from the record rather
-- than from memory.
create table if not exists public.sync_conflict (
  id               uuid        primary key default gen_random_uuid(),
  k_business       text        not null,

  -- Which table and row the conflict is about.
  table_name       text        not null,
  record_key       text        not null,

  -- Why it needs a human. Text, not an enum: the reasons are discovered in
  -- production and a new one must not need a migration.
  reason           text        not null,
  -- The values that disagree, so the decision does not need the run that found
  -- them to still be around.
  detail           jsonb       not null default '{}'::jsonb,

  resolution_state text        not null default 'open'
    constraint sync_conflict_resolution_check
    check (resolution_state in ('open', 'resolved', 'ignored', 'superseded')),
  resolved_by      text,
  resolved_at      timestamptz,
  resolution_note  text,

  -- Which run found it, for tracing back.
  found_by_run_id  text,
  trace_id         text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A resolved conflict must say who and when; an open one must not.
  constraint sync_conflict_resolved_together check (
    (resolution_state = 'open') = (resolved_at is null)
  )
);

comment on table public.sync_conflict is
  'Records needing human review. detail holds the values that disagree so the '
  'decision does not depend on the run that found them still being around.';

-- The queue a person actually works from.
create index if not exists sync_conflict_open_idx
  on public.sync_conflict (k_business, created_at)
  where resolution_state = 'open';
create index if not exists sync_conflict_record_idx
  on public.sync_conflict (table_name, record_key);
create index if not exists sync_conflict_run_idx
  on public.sync_conflict (found_by_run_id);

-- -----------------------------------------------------------------------------
-- Triggers and RLS
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sync_queue', 'sync_job_state', 'sync_run', 'sync_conflict']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.set_updated_at()',
                   t || '_set_updated_at', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
  raise notice 'sync tracking tables ready';
end
$$;

-- =============================================================================
-- Verification. Expect four rows, everything true.
-- =============================================================================
select
  c.relname as table_name,
  bool_or(a.attname = 'created_at') as has_created_at,
  bool_or(a.attname = 'updated_at') as has_updated_at,
  c.relrowsecurity as rls_on,
  exists (
    select 1 from pg_trigger tg
    where tg.tgrelid = c.oid and tg.tgname = c.relname || '_set_updated_at'
  ) as has_trigger
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public'
  and c.relname in ('sync_queue', 'sync_job_state', 'sync_run', 'sync_conflict')
group by c.relname, c.oid, c.relrowsecurity
order by c.relname;
