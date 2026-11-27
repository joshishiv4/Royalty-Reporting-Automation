# Progress: `sync_queue` retention — prune `done` rows on a 20-day window

## Checklist

- [ ] Check `n_dead_tup` / bloat from a SQL console, before the design is fixed
- [x] Migration: `prune_sync_queue(p_before, p_limit)`, batched — `0063`
- [x] Tests: state predicate holds; the 24-hour fresh-done floor survives a prune
- [x] CLI command, dry-run by default, loops until it returns 0 — `queue:prune`
- [x] Scheduled daily workflow — `.github/workflows/queue-prune.yml`, 05:30 UTC
- [ ] **Apply `0063` to the database**
- [ ] Clear the 1.5M-row backlog while the sync is idle
- [ ] Re-measure and record: `count(*)`, `done`, `pending`, `session_attendance`
- [ ] Confirm `attendance_sync` reaches `ok`
- [x] Docs: ARCHITECTURE, DATA-MODEL, STATUS (dated), RUNBOOK

## Last step

13 Oct 2026 — code complete and committed. Everything remaining is operational:
apply `0063`, clear the backlog, re-measure.

## Blockers

None. One open question that does not block the migration: whether a DELETE alone
restores performance, or whether the indexes need reindexing afterwards. It
changes the acceptance measurement, not the prune itself.

## Reopened 2026-11-26: 3-day retention, hourly prune, size cap

- [x] `0073`: oldest-first prune index, 24 h floor in SQL, row estimate, resolved-dead prune
- [x] `pruneQueue` (resolved dead 2 d → done 3 d → cap 300k), `queue_prune` sync_run row, exit 1 on failure
- [x] `queue-prune.yml` hourly at :50
- [x] Tests rewritten in `tests/sync-queue-prune.test.ts`
- [x] Docs: ARCHITECTURE, DATA-MODEL, STATUS (26 Nov), RUNBOOK §8h
- [x] `npm run verify` — 82 files, 1,008 tests pass
- [x] Mutation-check — 8 mutations, all red (see STATUS 26 Nov)
- [x] Read the 18/20/24 Nov prune logs — `57014` in the prune batch itself, 9–15 s in
- [~] Statement in `client_session_sync` — narrowed to a queue statement after the drain; log does not name it
- [x] Apply `0073` with the sync idle; watch the first hourly prunes clear the backlog — found applied 27 Nov; 713,690 → ~172,000
- [ ] Re-measure; 24 h of green hourly `sync` runs — re-measured 27 Nov, **still slow: bloat** (below)

## Reopened 2026-11-27: bounded, still slow — bloat

- [x] Measure the live table read-only (counts, timings, `attendance_sync` run history)
- [x] `0074`: per-table autovacuum, `2000 + 0.02 × rows` for vacuum and analyze
- [x] `supabase/checks/sync_queue_bloat.sql` — sizes, dead rows, settings (answers the first box of this file)
- [x] `enqueue()`: 200 rows a statement (100 at first; changed at the user's request), re-send a transient failure up to 3 times
- [x] Tests in `tests/sync-queue.test.ts`; 8 mutations, all red
- [x] Docs: ARCHITECTURE, DATA-MODEL, STATUS (27 Nov), RUNBOOK §8h
- [x] `npm run verify`
- [ ] Run `sync_queue_bloat.sql`, keep the output (user, SQL editor)
- [ ] `vacuum (full, analyze) public.sync_queue;` with the sync idle (user)
- [ ] Apply `0074`; deploy the `enqueue()` change
- [ ] Re-run the check; `attendance_sync` reaches `ok`; 24 h of green hourly `sync` runs
- [ ] A day later: `dead_rows` in the low thousands
- [ ] Decide: should a failed seed still drain what is queued? (changes `runPass` for every pass)
- [ ] Decide: should `attendance_sync` stop re-queueing all 48,716 sessions daily? (needs a rule for how far back WL attendance changes)

## Log

### 2026-11-27

- Hourly sync of 26 Nov 23:39 UTC (run 45912241531) failed in `attendance_sync`:
  `57014 ... [table=enqueue_sync_items]`. 30 chunks of 500 inserted in a 128 s
  seed, the 31st cancelled; 15,000 items pending, none processed (a seed failure
  ends the pass before it claims).
- `0073` is applied: the prune runs call its functions. 26 Nov 11:40 run removed
  500,000 by age + 413,690 by cap; 27 Nov 03:18 run reported 172,648 rows.
- Measured through PostgREST: 172,121 estimated rows; whole-table count
  cancelled at ~9 s; 97,302 `session_attendance` done rows in 7,064 ms. That is
  the open bloat question from 13 Oct, answered by timings. Not yet read:
  `n_dead_tup`, relation size — the new check script does.
- `attendance_sync` failed 24 of its last 40 runs (since 15 Nov). Its seed reads
  all 48,716 sessions and re-queues each once its `done` row leaves the 24 h
  window.
- User approved: `0074`, the `enqueue()` retry and smaller chunk, docs. Not
  approved yet: draining after a failed seed; narrowing the attendance seed.
- Mutations that each turned `tests/sync-queue.test.ts` red: chunk 500 (1 failed);
  no retry (3); retry every error (2); retry a 4xx (1); one try too many (1);
  pause does not grow (1); no pause (2); skip the failed chunk (3).

### 2026-11-26

- `client_session_sync` failed: `57014 ... [table=sync_queue]`. Table ~1.16M rows
  (estimated): ~1,159,000 done, 31 pending, 1,001 dead. 20-day retention at
  ~58k rows/day holds that much; the daily prune also failed 18, 20, 24 Nov.
- User chose: age rule first (3 days), size cap as safety net, resolved-dead
  cleanup, hourly prune with an alert.
- Found while writing tests: a 7-day wait on resolved dead rows outlives the
  3-day done row that proves resolution, so it would clear almost nothing. Set to
  2 days and ran that step before the age rule; a test simulates every success
  hour across two weeks.
- Later the same day, with C: freed: `npm run verify` green (1,008 tests). Mutations
  that each turned the prune tests red: retention 12 h (5 failed); cap ignores
  floor (1); cap ignores excess (2); overCap on maxBatches (1); dead wait 7 d (1,
  defaults); dead wait 2.5 d (1, defaults); age before dead (1, ordering test); no
  clamp + 7 d (2, incl. the hour-by-hour simulation).
- Prune failure logs read with `gh`: runs 44324546001, 44752003465, 45434486070
  all `57014` 9–15 s into the delete. Scheduled 05:30, they actually started
  14:17–16:13 UTC (GitHub delay), overlapping the hourly sync.

### 2026-10-13

- Task created. `attendance_sync` failed 01:15:53 UTC with
  `57014: canceling statement due to statement timeout [table=enqueue_sync_items]`,
  leaving 3,500 `session_attendance` items pending. Nothing dead.
- Measured `sync_queue`: **1,506,074 `done`** rows; `count(*)` on the whole table
  cancelled after 10,141 ms. Counting 3,500 `pending` rows through a partial index
  took 1,055 ms.
- Confirmed this is the blocker STATUS.md has carried since 23 Sep 2026, not a new
  fault. `0050` fixed one read (8.5–9.7 s → 0.28–1.1 s) and explicitly left the
  table size open; the failure has since moved to the INSERT in
  `enqueue_sync_items`.
- Retention set to **20 days** at the user's direction. The 24-hour fresh-done
  dedupe window is the floor; 20 days clears it 20× over.
- Implemented: `0063` (`prune_sync_queue`, batched via `ctid in (select … limit n)`,
  `done` only), `pruneDoneItems` in `src/sync/queue.ts` (loops, bounded by
  `maxBatches`, dry-run supported), `queue:prune` in the CLI (dry run by default,
  refuses `--days <= 1`), and a daily 05:30 UTC workflow. The :30 avoids the
  hourly sync, which runs on the hour, and `sync-monthly` on the 1st; still an
  hour before the alert sweep.
- `tests/sync-queue-prune.test.ts`, 8 cases. Mutation-checked both guarantees:
  retention of 12 h turns 4 red; dropping the `state = 'done'` predicate turns the
  "never removes a row that is not done" case red.
- Docs updated in the same commit: ARCHITECTURE (migration table, module map, CLI
  list), DATA-MODEL (control plane), STATUS (dated 13 Oct), RUNBOOK §8h with the
  full procedure including the bloat fallback.
- **Still to do, all operational:** apply `0063`, clear the backlog with the sync
  idle, re-measure. And the open bloat question — if a DELETE alone does not
  restore speed, `REINDEX` or `VACUUM FULL` is needed, and `n_dead_tup` from a SQL
  console is what says so.
