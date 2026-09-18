---
id: 025
title: Identity hub — identity, student and teacher, maintained by trigger
status: active
priority: high
depends_on: []
created: 2026-09-17
---

# Identity hub — `identity`, `student` and `teacher`

## Goal

The student dashboard (`spin-dj-pathways`) needs a human it can address that is
**not defined by WellnessLiving**. Today the only human in this database is
`person`, whose identity is WL's `uid` — a `NOT NULL` column. A student who signs
up through the portal and has never existed in WL cannot be represented at all.

This task introduces a central `identity` hub — one row per human — with `student`
and `teacher` as role tables hanging off it. WL stays a source *under* the central
model rather than being the model.

## Why a hub, and why this is not the design DATA-MODEL.md rejected

[DATA-MODEL.md](../../../docs/DATA-MODEL.md) records a rejected design: separate
`client` and `teacher` **tables**. It was rejected because all 20 records in
`/v1/staff/list` carry both a `k_staff` and a `uid`, and all 20 of those uids also
resolve as clients — so two unlinked tables count those 20 humans **twice** in
royalties. That is why `client` and `teacher` are views today.

This design is different and does not reopen that hole: **the hub is the one row
per human**, and `student`/`teacher` are *roles* attached to it. The double-count
is closed by a constraint on the hub rather than by refusing to have role tables.
The rejected design had no hub.

## Scope

- `identity` — the hub. One row per human. Holds links, nothing derived:
  `uid` (WL, nullable), `ghl_contact_id`, `student_id`, `teacher_id`,
  `auth_user_id`.
- `student` and `teacher` — role tables keyed on their own `uuid` id.
- Backfill from every existing `person` row.
- Three triggers, in the **same migration** as the backfill.
- Re-point the RLS policies from `0010` at the hub, in this same migration.
- Resolve the name collision: a **view** called `teacher` already exists
  ([`0014`](../../../supabase/migrations/0014_login_type_teacher.sql)). A `client`
  view also exists and overlaps `student` conceptually.

## Out of scope

- `organization`, `program`, `cohort` — task 026.
- The reconciliation check and health view — task 027.
- Portal auth and signup — task 028.
- Matching a portal-created student back to a WL person — task 030.
- The owned-content tables (pathway, project, interest, progress, feedback,
  creation, opportunity). Dropped from this round by the user, 17 Sep 2026.
- **Any change to `src/sync/`.** A deliberate outcome, not an omission — see below.

## The teacher rule

Teacher = `login_type.is_teacher_type`, which is `k_login_type` **1260510**
("Staff Client Profile") on the live business. Everyone else is a student.
Confirmed by the user 17 Sep 2026, and it is already the live rule — `0014`
implements exactly this.

Two measured consequences, recorded in `0014` on 24 Aug 2026, re-confirmed rather
than re-litigated:

- **Cameron Escovedo becomes a student** although WL gives him appointments.
- **Finance Team, Admin SpinDJAcademy, Pau Leogo and Ian Berk become teachers**
  although none of them teaches.

The two definitions agree on 15 of 20 and disagree on these 5. The studio was shown
this and confirmed the rule anyway.

## Why no sync code changes

`person` is upserted from **seven modules** across sixteen call sites:

```
src/sync/attendance.ts     src/sync/profiles.ts
src/sync/clients.ts        src/sync/recipients.ts
src/sync/pass.ts (x9)      src/sync/sessions.ts
src/sync/writer.ts
```

Filling the hub from sync code would mean changing all sixteen, and a future writer
that forgets leaves a silent hole. That is the same failure `0001` cites when it
refuses an `is_staff` flag: two places holding the same fact is how they come to
disagree.

A trigger on `person` needs zero call-site changes and cannot be forgotten by a
writer that does not know it exists.

## The three triggers

| # | Table | Event | `WHEN` | Effect |
|---|---|---|---|---|
| 1 | `person` | `AFTER INSERT` | — | create the `identity` row, and the role row if the role is known |
| 2 | `person` | `AFTER UPDATE OF k_login_type` | `OLD.k_login_type IS DISTINCT FROM NEW.k_login_type` | set or change the role |
| 3 | `login_type` | `AFTER INSERT OR UPDATE OF is_teacher_type` | `OLD.is_teacher_type IS DISTINCT FROM NEW.is_teacher_type` | re-classify **every** person on that type |

**Trigger 3 is the one that is easy to miss.** `0014` deliberately made the teacher
rule data: changing who counts as a teacher is an UPDATE there, not a deploy. Flip
`is_teacher_type` onto a different login type and everyone's role changes with **no
`person` row touched at all**. A trigger on `person` alone would never fire.

**The `WHEN` clause is not optional.** In Postgres, `UPDATE OF col` fires when the
column appears in the UPDATE statement, not when its value changes. The sync's
upsert writes `k_login_type = excluded.k_login_type` on every pass, so without
`IS DISTINCT FROM` trigger 2 fires on all ~1,285 rows every night for nothing.

## Rules the triggers must obey

- **One direction only.** `person` → hub. No trigger on `student`/`teacher` may
  write back to `person`, or one fact acquires two writers and a loop.
- **Idempotent.** The trigger body is itself an upsert, never a bare `INSERT` — the
  sync upserts the same rows continuously.
- **Backfill and triggers ship in ONE migration.** A row landing between the two is
  lost forever.

## Delete behaviour

No DELETE trigger. The FK from `identity` to `person` is **`ON DELETE SET NULL`**
(user decision, 17 Sep 2026).

Nothing in this system deletes — the sync is upsert-only, and `0027` settled that
deactivated clients stay, with `is_active` carrying the status. So a `person` delete
is an operator action, not a sync outcome.

`SET NULL` rather than `CASCADE` because the hub carries **owned data that has
nothing to do with WL** — a portal student's progress, feedback and projects. Losing
the WL mirror row must never destroy those. After the null, that identity is simply
indistinguishable from a portal-native student: no schedule, no attendance, no
purchases.

**`uid_detached` was designed and then dropped, 17 Sep 2026.** It was to preserve
the old uid so a later WL re-link was an exact match. It cannot be populated:
`ON DELETE SET NULL` nulls the column and a foreign key cannot copy it first, and
closing that needs a `BEFORE DELETE` trigger on `person` — which contradicts the
no-delete-trigger rule above. A column that never fills is a worse lie than an
absent one, so it is gone. **The re-link in task 030 is now always the fuzzy
match**, and task 030 has been corrected to say so.

## Stub people — an assumption, not an instruction

[`src/sync/recipients.ts:127`](../../../src/sync/recipients.ts) writes a person stub
of `{uid, k_business}` only, to hold an FK. Such a row has **no `k_login_type`**, so
its role is unknown.

**Assumed (b): create the `identity` row, leave the role row unset**, and let trigger
2 fill it when enrichment supplies the login type. A stub means "not yet known", not
"not a teacher". Defaulting to student would show a future teacher as a student in
the portal for the gap, and then need a correcting move. Unset is countable, which is
exactly what task 027's health check wants to count.

Raised with the user 17 Sep 2026; they did not choose, so this is the default taken.
Reversing it is a `WHERE` clause, not a redesign.

## Acceptance criteria

- [ ] `identity`, `student`, `teacher` exist, following the `0034`/`0035`
      conventions: `uuid id` PRIMARY KEY, natural key UNIQUE,
      `created_at`/`updated_at`/`synced_at`
- [ ] **`student` and `teacher` carry no WellnessLiving field whatsoever** — no
      `uid`, no `k_staff`, no `k_login_type`. Every WL key lives on `identity`,
      which is the mapping table and the only place one belongs. User rule,
      17 Sep 2026; it applies to every owned table, not only these two
- [ ] One human is one `identity` row — proved by a constraint, not by convention
- [ ] `identity.uid` is **nullable**; a row with `uid IS NULL` inserts cleanly
- [ ] Every existing `person` row has exactly one `identity` after backfill
- [ ] The 20 staff resolve to `teacher`; nobody holds both roles by accident
- [ ] Inserting a `person` creates its `identity` with no application code involved
- [ ] Changing a person's `k_login_type` moves their role
- [ ] Flipping `login_type.is_teacher_type` onto another type re-classifies everyone
      on it, with **zero `person` rows updated**
- [ ] Trigger 2 does **not** fire on a sync upsert that leaves `k_login_type`
      unchanged — measured against a real pass, not asserted
- [ ] Deleting a `person` nulls `identity.uid` and leaves the identity row and
      everything hanging off it intact. There is **no** `uid_detached` — see the
      delete-behaviour section for why it was dropped rather than left unfillable
- [ ] The `teacher` view name collision is resolved and nothing that read it is broken
- [ ] `0010`'s RLS policies key off the hub and still isolate one student from another
- [ ] `git diff --stat src/` is empty for this task
- [ ] Mutation-tested: each trigger broken deliberately, suite goes red, restored
- [ ] DATA-MODEL.md and ARCHITECTURE.md updated **in the same commit**

## Constraints & notes

- Money is `numeric(12,2)`; all WL keys are `text`. Hosts never appear in source.
- Migrations are numbered, self-contained and safe to re-run.
- A view is rewritten whole — see the STATUS.md section noting this has already cost
  the project twice.
- `person.auth_user_id` already exists (`0010`) and every RLS policy keys off it. It
  moves to the hub here; `0010`'s policies must move with it in the same commit.

## Resources

- `resources/` — empty. Source material is `docs/DATA-MODEL.md` and migrations
  `0001`, `0010`, `0014`, `0027`, `0034`, `0035`.
