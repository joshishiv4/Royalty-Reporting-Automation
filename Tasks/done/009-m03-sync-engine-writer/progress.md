# Progress: M03 sync engine — the writer and the durable queue loop

## Checklist

- [ ] Confirm scope with the user (reduced slice: staff + purchases, blockers deferred)
- [ ] Settle the five open questions, especially the attempt_count ↔ priorAttempt mapping
- [ ] Get live access sorted: Supabase org (task 007) + UAT WL (task 008)
- [ ] Split into sub-tasks (writer / queue loop / resume + route)
- [ ] Then build, per sub-task, with mutation-proven queue-transition tests

## Last step

Not yet started. This is a PRD awaiting scope confirmation and the open-question
answers — not a green light to code.

## Blockers

- Live Supabase access (task 007's blocker) and confirmed UAT WL (task 008) are
  needed to build the writer against anything real.
- Five open questions in task.md must be answered before coding.

## Log

### 2026-08-21
- PRD drafted from the M03 evaluation. Key finding carried in: the M02 control-plane
  schema (0007) was designed for exactly the client contract that now exists after
  the 001–006 error-handling fixes — WlErrorDetails ↔ sync_queue columns,
  requeueAfterMs ↔ next_attempt_at, null ↔ dead, runId ↔ sync_run.
- Scoped to the endpoints WL actually serves; attendance, margin, and the full
  client base are the three STATUS blockers and are explicitly out of scope.
- Flagged the attempt_count ↔ priorAttempt off-by-one as the one integration detail
  that must be pinned with a test before coding.

### 2026-08-21 — green-lit
- Four scope questions answered (all recommended): reduced slice, one-record queue
  rows, single worker per invocation, split into 3 sub-tasks.
- Two technical questions settled from the schema: priorAttempt = attempt_count
  (pre-increment) walks 1/5/25→dead; upsert on WL natural keys (constraints to be
  confirmed in 010).
- Split into 010 (writer + raw_link) → 011 (queue loop) → 012 (resume + route).
- Still gated on live access (007, 008) before any code.

### 2026-08-21 — done (umbrella complete)
- All sub-tasks landed: 013 (Supabase client), 010 (staff writer), 011 (queue loop),
  012 (route/sync_run), 014 (purchases), 015 (receipt money). The M03 reduced slice
  runs end to end against dev: staff -> person, purchases -> purchase/purchase_item,
  receipts -> money. Deferred by design: sync_job_state page cursor, sync_conflict
  creation, and the full client base (blocked upstream).
