-- =============================================================================
-- 0073  sync_queue stays bounded: oldest-first prune, a size cap, and resolved
--       dead rows
--
-- WHY THIS EXISTS
-- -----------------------------------------------------------------------------
-- 0063 gave sync_queue a retention window. It was not enough. On 26 Nov 2026 the
-- hourly sync failed again in client_session_sync with
--
--   SupabaseError: 57014: canceling statement due to statement timeout
--     [table=sync_queue]
--
-- with the table at about 1,160,000 rows (estimated, pg_class): ~1,159,000
-- done, 31 pending, 1,001 dead, ~709,000 of them session_attendance. That is
-- not a missed prune - it is what 20 days of retention HOLDS at ~58,000 rows a
-- day. And the daily prune itself failed on 18, 20 and 24 Nov 2026 (3 of the 8
-- runs before this), after about a minute each.
--
-- Three changes, all additive. Nothing here deletes a row; the service does,
-- through the functions below, in batches.
--
-- 1. AN INDEX THE PRUNE CAN WALK, AND OLDEST FIRST
-- -----------------------------------------------------------------------------
-- 0063's batch is `select ctid ... where state = 'done' and updated_at < p_before
-- limit n`. Nothing indexes that: 0050's sync_queue_fresh_done_idx leads on
-- (work_type, k_business), so the planner can only scan the table or the whole
-- index, filtering as it goes - and every batch steps over the dead tuples the
-- batches before it left, until autovacuum catches up. That is a statement whose
-- cost grows within one run, which is the likeliest reason a run that usually
-- takes a minute sometimes does not finish. (Likeliest, not proven: the step log
-- of the failed runs was not readable when this was written.)
--
-- sync_queue_done_updated_idx is (updated_at) where state = 'done'. The batch now
-- orders by updated_at, so it reads the OLDEST done rows straight off the index
-- and stops after p_limit - no sort, no scan of rows it will not delete. 0063
-- avoided an ORDER BY because without this index it meant sorting a million rows;
-- with it, ordering is free, and oldest-first is exactly what the size cap needs.
--
-- 2. A HARD 24-HOUR FLOOR, IN THE DATABASE
-- -----------------------------------------------------------------------------
-- enqueue()'s fresh-done dedupe reads `state = 'done' and updated_at >= now() -
-- 24h` (DEFAULT_FRESH_DONE_WINDOW_MS, src/sync/queue.ts). Prune inside that and
-- the dedupe goes blind and re-queues the same work the same day. 0063 left the
-- floor to the caller and the CLI's --days check. The size cap below is the first
-- caller whose cutoff is not a fixed number of days, so the floor moves here too:
-- `least(p_before, now() - interval '24 hours')`. A caller can ask for less; it
-- cannot get it.
--
-- 3. THE SIZE ESTIMATE, AND RESOLVED DEAD ROWS
-- -----------------------------------------------------------------------------
-- sync_queue_estimated_rows() returns n_live_tup from pg_stat_user_tables, which
-- the stats system keeps current as rows are inserted and deleted. Never
-- count(*): on this table that is the statement that stopped completing on 13 Oct
-- (cancelled at 10,141 ms). pg_class.reltuples is the fallback - it only moves on
-- VACUUM/ANALYZE, so straight after a large prune it is stale.
--
-- prune_resolved_dead_sync_queue(p_before, p_limit) removes a dead row once the
-- same target has been done SINCE. A dead row is final - the next sync queues the
-- target again as a NEW row (enqueue_sync_items skips only targets with a pending
-- or in_progress row, 0032) - so once that new row reaches done the dead one is
-- history that still reads as a live problem: the alert sweep counts dead rows
-- and its parked total caps at 1,000, which this table had passed. A dead row
-- with no later done row is the record of something still failing and is never
-- touched here.
--
-- sync_queue_done_target_idx is (work_type, target_key, k_business, updated_at)
-- where state = 'done', so "is there a later done row for this target" is one
-- index probe per dead row instead of a walk over every done row of its
-- work_type (~709,000 for session_attendance).
--
-- WHY NOT CREATE INDEX CONCURRENTLY: the reason 0050 gives. It cannot run in a
-- transaction, and a failed concurrent build leaves an INVALID index that `if not
-- exists` then skips for ever. A plain build blocks writes on sync_queue while it
-- runs. **Apply this while the sync is idle** (no `sync` run in progress in
-- GitHub Actions).
--
-- Safe to re-run.
-- =============================================================================

-- Two index builds over ~1.16M rows. Should finish in well under the default
-- timeout, but a timeout would roll the build back and look like nothing
-- happened - the same reasoning as 0050.
set statement_timeout = '10min';

create index if not exists sync_queue_done_updated_idx
  on public.sync_queue (updated_at)
  where state = 'done';

create index if not exists sync_queue_done_target_idx
  on public.sync_queue (work_type, target_key, k_business, updated_at)
  where state = 'done';

-- -----------------------------------------------------------------------------
-- prune_sync_queue: same signature and contract as 0063, now oldest-first and
-- with the 24-hour floor enforced here. Only 'done'.
-- -----------------------------------------------------------------------------
create or replace function public.prune_sync_queue(
  p_before timestamptz,
  p_limit  integer default 5000
)
returns integer
language sql
security invoker
as $$
  with doomed as (
    delete from public.sync_queue
     where ctid in (
       select ctid
         from public.sync_queue
        where state = 'done'
          and updated_at < least(p_before, now() - interval '24 hours')
        order by updated_at
        limit greatest(p_limit, 0)
     )
    returning 1
  )
  select coalesce(count(*), 0)::integer from doomed;
$$;

comment on function public.prune_sync_queue(timestamptz, integer) is
  'Deletes at most p_limit sync_queue rows that are done and older than p_before, '
  'oldest first, returning how many went. The cutoff is clamped to now() - 24h: '
  'enqueue()''s fresh-done dedupe reads the last day of done rows. Batched because '
  'one DELETE over a million rows hits the statement timeout it exists to prevent. '
  'Never touches pending, in_progress, failed or dead. (0063, 0073)';

-- -----------------------------------------------------------------------------
-- prune_resolved_dead_sync_queue: dead rows whose target has been done since.
-- -----------------------------------------------------------------------------
create or replace function public.prune_resolved_dead_sync_queue(
  p_before timestamptz,
  p_limit  integer default 5000
)
returns integer
language sql
security invoker
as $$
  with doomed as (
    delete from public.sync_queue
     where ctid in (
       select d.ctid
         from public.sync_queue d
        where d.state = 'dead'
          and d.updated_at < p_before
          and exists (
            select 1
              from public.sync_queue later
             where later.state = 'done'
               and later.work_type = d.work_type
               and later.target_key = d.target_key
               and later.k_business = d.k_business
               and later.updated_at > d.updated_at
          )
        limit greatest(p_limit, 0)
     )
    returning 1
  )
  select coalesce(count(*), 0)::integer from doomed;
$$;

comment on function public.prune_resolved_dead_sync_queue(timestamptz, integer) is
  'Deletes at most p_limit dead sync_queue rows older than p_before whose target '
  '(work_type, target_key, k_business) has a done row updated after the dead one - '
  'the retry that succeeded. A dead row with no later done row is still failing '
  'and is never touched. (0073)';

-- -----------------------------------------------------------------------------
-- sync_queue_estimated_rows: the size the cap is measured against, without
-- count(*).
-- -----------------------------------------------------------------------------
create or replace function public.sync_queue_estimated_rows()
returns bigint
language sql
stable
security invoker
as $$
  select coalesce(
    (select s.n_live_tup
       from pg_catalog.pg_stat_user_tables s
      where s.schemaname = 'public' and s.relname = 'sync_queue'),
    (select greatest(c.reltuples, 0)::bigint
       from pg_catalog.pg_class c
      where c.oid = 'public.sync_queue'::regclass),
    0
  );
$$;

comment on function public.sync_queue_estimated_rows() is
  'Estimated live rows in sync_queue: pg_stat_user_tables.n_live_tup, falling back '
  'to pg_class.reltuples. Never count(*) - on this table that stopped completing '
  'at ~1.5M rows (13 Oct 2026). Used by the size cap in src/sync/queue.ts. (0073)';

-- Service role only, like 0063's function: these delete, and the estimate says
-- nothing anyone outside the sync needs.
revoke all on function public.prune_resolved_dead_sync_queue(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.sync_queue_estimated_rows() from public, anon, authenticated;
grant execute on function public.prune_resolved_dead_sync_queue(timestamptz, integer) to service_role;
grant execute on function public.sync_queue_estimated_rows() to service_role;

reset statement_timeout;

-- -----------------------------------------------------------------------------
-- Trailing checks: refuse to finish if the pieces are not all there.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'sync_queue_done_updated_idx') then
    raise exception '0073: sync_queue_done_updated_idx is missing';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'sync_queue_done_target_idx') then
    raise exception '0073: sync_queue_done_target_idx is missing';
  end if;
  if exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
              where c.relname in ('sync_queue_done_updated_idx', 'sync_queue_done_target_idx')
                and not i.indisvalid) then
    raise exception '0073: an index exists but is INVALID - drop it and re-run';
  end if;
  if position('24 hours' in pg_get_functiondef('public.prune_sync_queue(timestamptz, integer)'::regprocedure)) = 0 then
    raise exception '0073: prune_sync_queue lost its 24-hour floor';
  end if;
  if public.sync_queue_estimated_rows() < 0 then
    raise exception '0073: sync_queue_estimated_rows returned a negative count';
  end if;
end;
$$;
