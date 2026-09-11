# Progress: M03b — the durable sync_queue claim, requeue and dead-letter loop

## Checklist

- [ ] Implement claim under lease (one worker per invocation)
- [ ] Translate client outcome → queue state + next_attempt_at
- [ ] Wire priorAttempt = attempt_count, test the 1-min first rung
- [ ] Reclaim expired in_progress leases

## Last step

Not yet started.

## Blockers

None on access — dev env is live (healthcheck green 2026-08-21): WL auth + fetch
and Supabase REST all confirmed, all 8 tables present. Blocked only on the task(s)
in depends_on landing first.

## Log

### 2026-08-21
- Created as an M03 sub-task when PRD 009 was green-lit. Decisions live in 009.

### 2026-08-21 — done
- src/sync/queue.ts: enqueue (idempotent via active-target filter), reclaimExpired,
  claimBatch (compare-and-swap over PostgREST — no RPC/migration), settle
  (done/requeue/dead), runQueue, outcomeFromWlError. Added SupabaseClient.update (PATCH).
- priorAttempt = attempt_count wiring; settle increments on requeue (decision 4),
  mutation-verified (drop the +1 → red).
- 11 unit tests + live proof against dev: enqueue staff_list → runQueue (real WL
  fetch + writeStaffList) → item 'done'; second pass claims 0; cleanup PASS.
- Registered in ARCHITECTURE. npm run verify: 244 tests green.
- Not built: sync_conflict creation (no conflict case in the staff path yet) — left
  for when a work type needs it.
