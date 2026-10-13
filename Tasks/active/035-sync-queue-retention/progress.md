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

## Log

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
