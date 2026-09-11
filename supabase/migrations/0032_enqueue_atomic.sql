-- =============================================================================
-- 0032  enqueue_sync_items - queueing work without a read-then-write race
--
-- THE BUG THIS CLOSES, MEASURED.
--   `enqueue()` deduped with a paged SELECT and then INSERTed, with nothing
--   holding between the two. sync:full-parallel starts every pass in the same
--   instant, and a run whose process died is never closed, so two runs of one
--   pass overlap easily. One drains rows pending -> done while the other is
--   paging the dedupe read; rows shift under the offset, that read skips them,
--   and the insert collides:
--
--     23505: duplicate key value violates unique constraint
--            "sync_queue_active_target_key"
--
--   Observed live 31 Aug 2026, and it killed attendance_sync outright - 32,440
--   items left unqueued.
--
-- WHY THIS COULD NOT BE FIXED THROUGH POSTGREST.
--   sync_queue's rule is a PARTIAL unique index - one ACTIVE item per target,
--   `where state in ('pending','in_progress')` - so the same record may be
--   queued again once today's item is done. Probed live against this database,
--   every route PostgREST offers fails:
--
--     plain insert                            -> 23505
--     Prefer: resolution=ignore-duplicates    -> 23505  (it infers the PRIMARY
--                                                KEY, a generated uuid, which
--                                                never conflicts)
--     ?on_conflict=work_type,target_key,k_business
--                                             -> 42P10 "there is no unique or
--                                                exclusion constraint matching
--                                                the ON CONFLICT specification"
--
--   The last is Postgres being correct: inferring a PARTIAL index requires
--   repeating its WHERE clause, and PostgREST has no syntax for that.
--
--   A bare `ON CONFLICT DO NOTHING` with NO target does honour every unique
--   index on the table, partial ones included - but only raw SQL can write it.
--   Hence a function.
--
-- WHY DO NOTHING RATHER THAN AN ERROR.
--   A duplicate here is not a failure. It means the target already has an active
--   item, which is precisely the state the index exists to guarantee. The right
--   answer is to skip that row and carry on, not to kill the pass.
--
-- Safe to re-run.
-- =============================================================================

create or replace function public.enqueue_sync_items(items jsonb)
returns integer
language sql
security invoker
as $$
  with inserted as (
    insert into public.sync_queue (work_type, target_key, k_business, state, next_attempt_at)
    select x.work_type,
           x.target_key,
           x.k_business,
           'pending',
           coalesce(x.next_attempt_at, now())
      from jsonb_to_recordset(items) as x(
             work_type       text,
             target_key      text,
             k_business      text,
             next_attempt_at timestamptz
           )
     -- No conflict target: that is the whole point. Naming one would restrict
     -- this to a single index and miss the partial one it exists for.
     on conflict do nothing
    returning 1
  )
  select coalesce(count(*), 0)::integer from inserted;
$$;

comment on function public.enqueue_sync_items(jsonb) is
  'Queues work in one atomic statement, skipping targets that already have an '
  'active item. Returns how many rows were ACTUALLY inserted - the difference '
  'from what was sent is the races a dedupe read cannot see. Exists because '
  'PostgREST cannot express ON CONFLICT DO NOTHING against a partial index.';
