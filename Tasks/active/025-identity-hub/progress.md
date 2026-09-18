# Progress: Identity hub

## Checklist

- [x] Design the identity / student / teacher DDL, uid nullable, no WL field on the role tables
- [x] Resolve the teacher view name collision (0014) and the client view overlap
- [x] Write the migration: tables, backfill, three triggers, RLS re-point, all in one file
- [ ] Prove trigger 2 does not fire on an unchanged sync upsert, measured on a real pass
- [ ] Prove trigger 3 re-classifies with zero person rows touched
- [ ] Prove ON DELETE SET NULL preserves the identity (no uid_detached — dropped)
- [ ] Mutation-test each trigger: break, confirm red, restore
- [ ] Update DATA-MODEL.md and ARCHITECTURE.md in the same commit

## Last step

Subtasks 1.1-1.4 written as migrations 0039 and 0040, plus a proof script. Nothing applied to a database yet.

## Blockers

None.

## Log

### 2026-09-17
- Task created.

### 2026-09-17
- Subtask 1.1 done: migration 0039 creates identity, student and teacher.
- identity.uid is nullable with ON DELETE SET NULL, plus uid_detached so a later
  re-link is exact rather than a phone-and-email guess.
- identity_one_role_check enforces the confirmed rule that student and teacher are
  exclusive. Reversing that is dropping one constraint.
- The 0014 teacher VIEW was renamed to wl_teacher rather than dropped. It is the
  WL-shaped projection royalty reporting will want, and dropping something because
  the work needing it has not started is a guess. Only supabase/checks/rls_bypass_check.sql
  referenced it; updated in the same commit.
- Backfill and triggers deliberately NOT in 0039. They go in 0040 together, because
  a row inserted between a backfill and the trigger meant to catch it is lost with
  nothing to say so. 0039 alone is inert - nothing reads these tables yet.
- npm run verify: 815 tests across 69 files, all green.
- DATA-MODEL.md and ARCHITECTURE.md updated in the same commit. While doing so the
  table count was found stale AGAIN - the header claimed 26 tables and 16 views;
  counted from the migrations it is 31 and 19. It had drifted five tables and three
  views before this task touched anything. Corrected, with the counting commands
  named so the next person measures instead of guessing.

### Not yet verified
- Nothing here has been applied to a live database. The DDL is written and the
  suite is green, but green means the repo is consistent, not that Postgres accepted
  this. Apply and check before starting 1.2.

### 2026-09-17 (later)
- Renumbered. 0038_pay_transaction landed in the repo DURING this work - the tree
  ended at 0035 when it started - so the new files went in BEFORE an existing
  migration. Moved to 0039 and 0040.
- Subtasks 1.2, 1.3 and 1.4 done as ONE migration, 0040: backfill plus three
  triggers. Split across two files, a person inserted in the gap is lost silently.
- One function, identity_sync_person, is called by the backfill AND all three
  triggers. A backfill written separately is a second copy of the rule and the two
  drift.
- Trigger 2 uses IS DISTINCT FROM, not just UPDATE OF: in Postgres UPDATE OF fires
  when the column appears in the statement, not when the value changes, and the
  sync writes k_login_type on every row every night.
- Role change UNLINKS the old role row rather than deleting it. Once progress and
  feedback hang off a student row, deleting would mean a nightly sync silently
  destroying portal data because somebody changed a type in WellnessLiving.
- supabase/checks/identity_trigger_cases.sql proves the criteria by doing, not by
  inspecting the catalogue. Writes inside BEGIN ... ROLLBACK.
- npm run verify: 815 tests across 69 files, green.

### Blocker CLOSED: uid_detached dropped (user decision, 17 Sep 2026)
- Option 2 taken: the column is gone rather than left as one that never fills.
  A column task 030 would read and find null — concluding "no previous uid" when
  the truth is "never recorded" — is a worse lie than an absent one.
- Removed from 0039 (column, comment, index). A comment block stands in its place
  explaining why there is no such column, so the next person does not re-add it.
- Check file section 7 rewritten: it now captures the identity id BEFORE the
  delete and proves survival, which is the guarantee that actually remains.
- Cost recorded where it lands, not hidden: task 030 lost its exact-match path and
  now always runs the fuzzy matcher. Its task.md and progress.md say so, and both
  name the condition under which to reopen it — a real person delete path.
- DATA-MODEL.md, task.md 025 and task 030 updated in the same commit.

### Bug found on the FIRST live apply: trigger 3 would not create
- Ran in the Supabase SQL editor 17 Sep 2026 and Postgres refused 0040:
  `ERROR: 42703: column "tg_op" does not exist`, at the WHEN clause of
  login_type_identity_rule.
- TG_OP is a PL/pgSQL variable of a trigger FUNCTION BODY. A WHEN clause is plain
  SQL over OLD and NEW and has no such thing. The suite could not have caught
  this: 815 tests prove the repo is consistent, not that Postgres accepts the DDL.
- Correcting only the spelling fails again one line down —
  `INSERT trigger's WHEN condition cannot reference OLD values` — so the condition
  cannot be written once for a combined INSERT OR UPDATE trigger.
- Fixed as TWO triggers sharing one function:
  login_type_identity_rule_insert and login_type_identity_rule_update. The
  alternative, moving the test into the function body where TG_OP does work, would
  call the function on every statement naming is_teacher_type just to return -
  the exact cost trigger 2's WHEN clause exists to avoid.
- 0040 still drops the old single-trigger name, so a partly-applied database
  cleans up on re-run.

### Original blocker report (kept - the measurement is the useful part)
- ON DELETE SET NULL nulls identity.uid, but a foreign key cannot COPY the value
  before nulling it. So uid_detached is never populated and the exact re-link it
  exists for does not happen - task 030 falls back to a phone-and-email guess.
- Closing it needs a BEFORE DELETE trigger on person, which contradicts the
  instruction of 17 Sep 2026 that there be no trigger on delete.
- Not decided unilaterally. Either the rule bends for this one case, or
  uid_detached should be dropped rather than left as a column that never fills.
- Section 7 of the check file documents the gap and will FAIL until it is settled.
