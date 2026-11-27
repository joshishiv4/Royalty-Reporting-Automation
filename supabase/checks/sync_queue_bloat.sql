-- =============================================================================
-- sync_queue bloat check - read-only, changes nothing
--
-- WHY THIS EXISTS. On 27 Nov 2026 sync_queue held ~172,000 rows and still could
-- not be counted inside the statement timeout (~9 s), and a 500-row insert took
-- seconds - the timings of a table that still occupies the space of the 1.5
-- million rows it used to hold. PostgREST cannot read pg_stat or a relation
-- size, so "is it bloat" had only ever been inferred. This is the direct answer.
--
-- Run it in the SQL editor:
--   BEFORE  `vacuum (full, analyze) public.sync_queue;`  (RUNBOOK 8h) - to
--           confirm the space is there to reclaim;
--   AFTER   it - total size should fall to roughly live rows x a few hundred
--           bytes, plus indexes;
--   A DAY LATER - dead_rows should sit in the low thousands. If it is back in the
--           tens of thousands, 0074's autovacuum settings are not holding.
--
-- HOW TO READ IT. A sync_queue row is a few hundred bytes. heap_bytes_per_live_row
-- in the thousands means most of the table is space it no longer uses; the same
-- reading applies to each index against the rows it covers.
--
-- One statement, so the SQL editor shows all of it (it shows only the last
-- result of a script).
-- =============================================================================

with t as (
  select s.n_live_tup,
         s.n_dead_tup,
         s.last_autovacuum,
         s.last_autoanalyze,
         s.autovacuum_count,
         pg_relation_size('public.sync_queue')       as heap_bytes,
         pg_indexes_size('public.sync_queue')        as index_bytes,
         pg_total_relation_size('public.sync_queue') as total_bytes
    from pg_catalog.pg_stat_user_tables s
   where s.schemaname = 'public' and s.relname = 'sync_queue'
),
facts (ord, item, value) as (
  select 10, 'live_rows (estimate)',      n_live_tup::text from t
  union all
  select 11, 'dead_rows (estimate)',      n_dead_tup::text from t
  union all
  select 12, 'dead per 100 live',
         round(100.0 * n_dead_tup / greatest(n_live_tup, 1), 1)::text from t
  union all
  select 20, 'total size',                pg_size_pretty(total_bytes) from t
  union all
  select 21, 'heap size',                 pg_size_pretty(heap_bytes) from t
  union all
  select 22, 'all indexes size',          pg_size_pretty(index_bytes) from t
  union all
  select 23, 'heap_bytes_per_live_row',
         (heap_bytes / greatest(n_live_tup, 1))::text from t
  union all
  select 30, 'last_autovacuum',           coalesce(last_autovacuum::text, 'never') from t
  union all
  select 31, 'last_autoanalyze',          coalesce(last_autoanalyze::text, 'never') from t
  union all
  select 32, 'autovacuum_count',          autovacuum_count::text from t
  union all
  -- 0074's settings. NULL here means 0074 is not applied and the instance
  -- defaults below are what govern this table.
  select 40, 'table reloptions (0074)',
         coalesce(array_to_string(c.reloptions, ', '), 'none - 0074 not applied')
    from pg_catalog.pg_class c
   where c.oid = 'public.sync_queue'::regclass
  union all
  select 41, 'instance autovacuum_vacuum_threshold',
         current_setting('autovacuum_vacuum_threshold')
  union all
  select 42, 'instance autovacuum_vacuum_scale_factor',
         current_setting('autovacuum_vacuum_scale_factor')
  union all
  select 43, 'instance autovacuum_analyze_scale_factor',
         current_setting('autovacuum_analyze_scale_factor')
  union all
  -- One row per index, largest first within the block.
  select 50 + (row_number() over (order by pg_relation_size(i.indexrelid) desc))::int,
         'index ' || ic.relname,
         pg_size_pretty(pg_relation_size(i.indexrelid))
    from pg_catalog.pg_index i
    join pg_catalog.pg_class ic on ic.oid = i.indexrelid
   where i.indrelid = 'public.sync_queue'::regclass
)
select item, value
  from facts
 order by ord;
