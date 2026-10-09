---
id: 033
title: Teacher notes — private (personal) and public (to a student), the portal's first write path
status: active
priority: high
depends_on: [032]
created: 2026-10-09
---

# Teacher notes — private (personal) and public (to a student)

## Goal

Let a signed-in teacher keep notes in the portal. A **private** note is the
teacher's own — personal, attached to no student, visible only to its author. A
**public** note is written *about a particular student the teacher taught*, and is
visible to its author teacher **and** to that one student. No other teacher and no
other student can read either kind.

This is the portal's **first write path**. Every RLS policy in this database today
is `for select` only (migrations `0053`, `0055`), and `0055` names this explicitly:
"the first [write policy] is a larger argument than a migration should settle on
its way past." This task is that argument, scoped and made on purpose.

## Scope

**Schema (`Royalty-Reporting-Automation`, new migration `0056`)**

- New table `app.teacher_note`, portal-native (no WellnessLiving field), following
  the owned-table conventions in DATA-MODEL.md:
  - `id uuid` primary key (the `0035` pattern).
  - `organization_id uuid not null`, filled by a `before insert` trigger calling
    the existing `app.organization_stamp()` (`0048`), never a default.
  - `author_teacher_id uuid not null references app.teacher(id)`.
  - `student_id uuid references app.student(id)` — **nullable**.
  - `visibility text not null check (visibility in ('private','public'))`.
  - `body text not null`, non-empty (`check (length(btrim(body)) > 0)`).
  - `created_at`, `updated_at` (the shared `set_updated_at` trigger). **No
    `synced_at`** — nothing syncs this table from WL.
  - One constraint carries the whole rule:
    `check ((visibility = 'private' and student_id is null) or
            (visibility = 'public'  and student_id is not null))`.
- **RLS — the first write policies in the database.** All `to authenticated`:
  - SELECT (author): `author_teacher_id = app.current_teacher_id()`.
  - SELECT (student): `visibility = 'public' and student_id = app.current_student_id()`.
  - INSERT (`with check`): `author_teacher_id = app.current_teacher_id()` **and**
    `(visibility = 'private' or app.teaches_student(student_id))`.
  - UPDATE (`using` + `with check`): author only, same shape as INSERT.
  - DELETE (`using`): `author_teacher_id = app.current_teacher_id()`.
  - No policy may name a table inline — use the existing `SECURITY DEFINER`
    helpers (`current_teacher_id`, `current_student_id`, `teaches_student`) only,
    for the 42P17 reason `0055` documents.
- `grant select, insert, update, delete on app.teacher_note to authenticated`
  and `to service_role` (a policy with no grant fails `permission denied` —
  `0053`/`0055`).
- Trailing `do $$ ... $$` checks in the migration, in the `0055` style: the
  trigger exists, every policy is on the expected command, the check constraint is
  present, and `authenticated` holds the four privileges.
- Register `0056` in ARCHITECTURE.md's migration table and document the table and
  its reasoning in DATA-MODEL.md, **in the same commit** (CLAUDE.md rule).

**RLS proof (`Royalty-Reporting-Automation`)**

- A `supabase/checks/` SQL script in the `portal_auth_isolation.sql` style that
  proves, against seeded test rows: author reads both kinds; a targeted student
  reads the public note and not the private one; a non-targeted student reads
  neither; a teacher cannot insert a public note for a student they did not teach;
  a teacher cannot read, edit or delete another teacher's note; signed-out reads
  nothing. Each assertion must be shown to go red when its policy is removed
  (mutation-checked, per CLAUDE.md "Testing").

**Portal (`spin-dj-pathways`)**

- API route handlers under `app/api/v1/notes/`, using **`sessionSupabase()`**
  (anon key + viewer JWT, RLS-enforced) — never the service-role client in
  `supabase.ts`. Pattern: `app/api/v1/teachers/me/roster/route.ts`.
  - `GET /api/v1/notes` — the signed-in teacher's own notes (author SELECT).
  - `POST /api/v1/notes` — create (private personal, or public + `student_id`).
  - `PATCH /api/v1/notes/[id]` — edit body.
  - `DELETE /api/v1/notes/[id]` — delete.
  - `GET /api/v1/students/me/notes` — the signed-in student's public notes,
    grouped by author teacher (student SELECT).
- Teacher UI: list own notes; create with a private/public toggle and, for public,
  a student picker sourced from the roster endpoint; edit and delete.
- Student UI: a read-only list of public notes addressed to them, grouped by
  teacher, newest first.

## Out of scope

- Teacher sign-in itself — done (migration `0055`, `/teacher`, task 032).
- Any note type other than private/personal and public-to-one-student. No
  teacher↔teacher notes, no studio-wide broadcast, no replies/threads from the
  student side (a note is one-way; the student reads, does not answer).
- Attachments on notes, rich text, notifications/email on a new note.
- A teacher reading student uploads (`app.creation`) — `0055` deferred that
  deliberately as a separate question.
- Changing any existing SELECT policy from `0053`/`0055`. New policies are added
  alongside; the isolation checks for those must still pass unchanged.

## Acceptance criteria

- [ ] `0056` creates `app.teacher_note` with the columns, the visibility/student
      check constraint, the `organization_stamp` and `set_updated_at` triggers,
      and the five RLS policies; its trailing checks pass in the SQL editor.
- [ ] A teacher can create, read, edit and delete their own private and public
      notes through the portal.
- [ ] A public note is readable by exactly the targeted student and its author;
      a private note is readable by its author alone.
- [ ] A teacher cannot create or move a public note onto a student
      `app.teaches_student()` says they did not teach (write is refused by RLS,
      not by a handler check).
- [ ] No teacher can read, edit or delete another teacher's note; no student can
      read another student's public note or any private note.
- [ ] The `supabase/checks/` proof asserts all of the above and each assertion is
      shown to go red when its policy is dropped.
- [ ] Portal routes use `sessionSupabase()` (RLS), not the service-role client.
- [ ] `0053`/`0055` isolation checks still pass unchanged.
- [ ] DATA-MODEL.md and ARCHITECTURE.md updated in the same commit as `0056`.

## Constraints & notes

- **Decided (user, 9 Oct 2026):** private = personal, no student; public = to one
  student; notes are a many-per-student log; edit and delete both allowed.
- **Public-note visibility persists.** The student SELECT policy matches on
  `student_id = current_student_id()` only — it does **not** re-check
  `teaches_student()`. `teaches_student()` is attendance-derived and can change; a
  note once addressed to a student stays visible to them. The roster check is
  enforced only at **write** time (who you may address), which is the honest place
  for it. Recorded here because the asymmetry is deliberate.
- The migration is applied by hand in the Supabase SQL editor (no DDL path in the
  repo — `0001`–`0055` were all applied this way; RUNBOOK/STATUS).
- `app.organization_stamp()` uses `select ... into strict`, so it fails loudly the
  day a second organization exists — correct, inherited, nothing to add.
- STATUS.md still lists task 032 (teacher sign-in) as "not started"; that is
  stale — `0055` is applied and `/teacher` works. Worth correcting STATUS.md's
  M05 line while here.

## Resources

- `resources/` — empty for now. Add the applied-migration output or SQL-editor
  check transcripts here as the migration lands.
