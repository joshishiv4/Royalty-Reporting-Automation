---
id: 035
title: sync_queue retention — prune done rows on a 20-day window
status: active
priority: high
depends_on: []
created: 2026-10-13
---

# `sync_queue` retention — prune `done` rows on a 20-day window

## Goal

`sync_queue` has never been pruned. It holds **1,506,074 `done` rows** and a plain
`count(*)` on it no longer completes — 10,141 ms, cancelled. Statements against it
cross the statement timeout and kill passes that had nothing wrong with them.

End state: a retention window of **20 days**, a prune that enforces it in batches,
something that runs it on a schedule, and the existing 1.5M-row backlog cleared.
The table stops growing without bound, and `57014` stops being a routine failure
mode.

## Why now, and why indexes are not the answer

This is the third time this table's size has broken a pass, and the second fix
that only moved the bottleneck:

| date | rows | what happened |
|---|---|---|
| 23 Sep 2026 | 532,415 (532,412 `done`) | claim and enqueue 1.3–2.0 s each; `purchase` and `purchase_item` 21.9 hours stale |
| 30 Sep 2026 | — | `enqueue()`'s fresh-done dedupe killed **16 of 18** passes 10–52 s in |
| 1 Oct 2026 | 869,798 (823,322 `done`) | `0050` indexed that read; 8.5–9.7 s → 0.28–1.1 s |
| **13 Oct 2026** | **1,506,074 `done`** | `attendance_sync` fails in `enqueue_sync_items` — the INSERT itself now |

[STATUS.md](../../../docs/STATUS.md) has said since 23 Sep: *"A retention window
plus a scheduled cleanup is the fix; neither is written."* `0050`'s own note says
it *"does not shrink the table, so the cleanup above is still open."* Each index
bought time against a table that kept growing; the table has tripled in three
weeks.

Measured 13 Oct 2026:

| query | rows | time |
|---|---|---|
| `state = 'done'` | 1,506,074 | 3,222 ms |
| `state = 'pending'` | 3,500 | 1,055 ms |
| `work_type = 'session_attendance'` | 943,399 | 2,354 ms |
| `count(*)` whole table | — | **10,141 ms, cancelled** |

Counting 3,500 pending rows through a partial index takes a second. That is the
shape of the problem.

## The 20-day window, and the floor underneath it

**Retention is 20 days.** `done` rows older than that are deleted.

**The floor is 24 hours and it is not negotiable.** `enqueue()`'s fresh-done
dedupe reads `state = 'done' AND updated_at >= now() - 24h`
([queue.ts:217](../../../src/sync/queue.ts), `DEFAULT_FRESH_DONE_WINDOW_MS`) to
decide whether a target was already refreshed today. Prune inside that window and
the dedupe goes blind and re-queues work the same day — a size problem traded for
a correctness one. 20 days clears it by a factor of 20 while still removing the
overwhelming majority of the table.

A `done` row older than 20 days has no reader. The dedupe cannot see it, the
claim filters on `pending`, and `countEligible` filters on `pending`. It is
history nothing consults.

## Scope

- A migration adding `prune_sync_queue(p_before timestamptz, p_limit int)` —
  a **batched** delete returning the number of rows removed.
- A CLI command that loops it until it returns 0, with the window configurable
  and a dry-run default consistent with `scripts/requeue.mjs` and `window.mjs`.
- A scheduled GitHub Actions workflow that runs it daily, alongside `sync.yml`
  and `alerts.yml`.
- Clearing the existing 1.5M-row backlog, as an operated run rather than a
  migration.
- Docs: ARCHITECTURE migration table and module map, DATA-MODEL control-plane
  section, STATUS (dated), RUNBOOK procedure.

## Out of scope

- Pruning `raw_wl` or any other table. `0008` has its own retention story.
- Partitioning `sync_queue`. A retention window is the smaller change and has to
  be tried first.
- The `0060` post-drain count index. Different statement, already in flight.
- Changing the fresh-done window itself.

## Acceptance criteria

- [ ] `prune_sync_queue` exists, deletes only `state = 'done'` rows strictly older
      than the given timestamp, and honours `p_limit` per call
- [ ] A test proves it refuses to delete a `pending`, `in_progress`, `failed` or
      `dead` row, and that removing the state predicate turns the test red
- [ ] A test proves a `done` row inside the 24-hour fresh-done window survives a
      20-day prune — the correctness floor, stated as a test rather than a comment
- [ ] The CLI command loops to completion, is dry-run by default, and reports how
      many rows it would remove
- [ ] A scheduled workflow runs it daily
- [ ] The backlog is cleared: `count(*)` on `sync_queue` completes, and the three
      measurements above are re-taken and recorded
- [ ] `attendance_sync` reaches `ok` with no `57014`
- [ ] Docs updated in the same commit, STATUS carrying the date

## Constraints & notes

**Batch, never one statement.** A single DELETE of 1.5M rows hits the same
statement timeout this task exists to fix, and holds locks on a table seventeen
other passes are using. 5–10k per call, looped.

**Run the backlog clear when the sync is idle.** Competing with a live pass for
the same table is how this becomes an incident instead of a cleanup.

**Deleting rows may not be sufficient.** If the slowness is bloat rather than row
count, indexes stay bloated after a DELETE and want `REINDEX` or `VACUUM FULL` to
reclaim. `pg_stat_user_tables.n_dead_tup` from a SQL console settles it — worth
checking **before** committing to the design, because it changes what "done"
means here. PostgREST will not answer it.

**The failure this fixes reported itself correctly.** `attendance_sync` recorded
`failed` with the reason and table, unlike the 9 Oct orphaned run. Nothing is
hidden; the work simply does not happen.

## Resources

- `resources/` — empty. The measurements are in this file and in STATUS.md.
