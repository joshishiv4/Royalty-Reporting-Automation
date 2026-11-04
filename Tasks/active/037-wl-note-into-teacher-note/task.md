---
id: 037
title: WellnessLiving profile notes into app.teacher_note, linked and kept in sync
status: active
priority: medium
depends_on: [033]
created: 2026-10-28
---

# WellnessLiving profile notes into `app.teacher_note`

## Goal

The studio's WellnessLiving profile notes become ordinary rows of the portal's own
notes table, `app.teacher_note`, instead of being read through two side functions.
One notes table, one place the portal reads from, and the sync keeps it current:
a note that appears, changes or disappears in WellnessLiving does the same in
`teacher_note` on the next pass, by trigger, with nobody copying anything by hand.

Today (`0064`/`0065`/`0066`) the notes live in `public.wl_client_note` and reach the
portal through `app.my_wl_note()` and `app.my_students_wl_notes()`. The portal merges
them with `teacher_note` itself.

## Decisions (from the user, 28 Oct 2026)

- **No new notes table in `app`.** WL notes go into the existing `app.teacher_note`.
- **The WL key never sits on `teacher_note`.** Provenance is a link table,
  `app.teacher_note_link`, the same pattern as `cohort_link`, `session_link` and
  `attendance_link` (`0041`, `0043`): *presence of a link is the provenance*, so there
  is no `source` column and no `is_wl_note` flag that could disagree with it.
- **The link carries the WL `uid`** (text), not `wl_client_note.id`: the uid is WL's
  own stable key, while a `wl_client_note` row is deleted and re-created when a note
  goes and comes back.
- **Only students' notes** become student-facing notes. Who is a student is
  `app.identity.student_id is not null`, joined on `uid` (measured on dev, 28 Oct
  2026: 339 clients with a note = 334 students, 5 teachers, all with exactly one identity, 0 uids with
  several identities).
- **No date from WellnessLiving.** WL returns no author and no written date
  (STATUS, blocked 5; re-probed live 28 Oct 2026, `o_note` has no such cell field).
  `0066` dropped `note_seen_at` for that reason.
- **Migrations live in Royalty Reporting** (`supabase/migrations/`); portal changes in
  `spin-dj-pathways`.

## Decisions confirmed (from the user, 28 Oct 2026)

1. **A teacher's own WL note (5 on dev)** becomes a **private** note authored by
   **that teacher**, no student. The teacher reads what staff wrote about them in WL;
   accepted knowingly. Because it has an author, the existing author policies would
   let that teacher edit or delete it — so a linked note must be read-only through
   the API (see Scope).
2. **The two `0065` functions are dropped** in the same migration; the portal stops
   calling them. Keeping them would show every WL note twice.
3. **`created_at` of a WL note is `now()`** when the trigger first copies it; the
   portal shows WL notes without a date, as since `0066`.

## Scope

**Database — new migration `0067` (Royalty Reporting)**
- `app.teacher_note_link (teacher_note_id uuid primary key references
  app.teacher_note on delete cascade, uid text not null unique)`. No other columns.
  RLS on; grants as the other link tables.
- `app.teacher_note.author_teacher_id` becomes **nullable**. A null author is allowed
  **only** on a linked note — enforced in the database (constraint trigger or
  deferred check), not only in the portal, so a portal write with no author is
  refused.
- `0057`'s revision trigger writes `author_teacher_id` (NOT NULL) on every body
  change. A WL note's body changes whenever staff edit it in WL, so the trigger must
  skip linked notes (or the revision column becomes nullable) — otherwise the sync
  fails on the first edited note.
- Trigger on `public.wl_client_note`:
  - INSERT, for a uid whose identity is a student → `teacher_note`
    (`visibility = 'public'`, `student_id` from identity, `author_teacher_id` null,
    `body = note_text`) + its link row.
  - UPDATE of `note_text` → update the linked note's `body`.
  - DELETE (sync saw `has_note: false`) → soft-delete the linked note
    (`deleted_at = now()`, `0058`). A note that comes back later re-uses the link.
  - Note with null `note_text` ("Note with no text") → no note, as `0065` did.
  - A uid that is neither a student nor a teacher → nothing.
- One-time backfill of the existing notes, in the same file, before the trigger
  (the `0040` reasoning: a row inserted between a backfill and its trigger is lost).
- Read access:
  - Student: already covered by `teacher_note_student_select`
    (`public` + `student_id = current_student_id()`).
  - Teacher: a new SELECT policy so a teacher reads the **linked** notes of students
    they teach, through a SECURITY DEFINER helper (`app.teaches_student`), never an
    inline read of another policied table (the `0055` 42P17 rule).
  - Nobody can UPDATE or DELETE a linked note through the API. For a student's WL
    note the null author already fails the author policies; a teacher's own WL note
    (decision 1) HAS an author, so the update and delete policies also require "not
    linked", through a SECURITY DEFINER helper rather than an inline read of the
    link table. The trigger writes as the table owner, so it is not blocked.
- A uid whose identity is a teacher → a **private** note, `author_teacher_id` = that
  teacher, no student (decision 1).
- Decision 2: drop the two `0065` functions.
- Trailing checks, safe to re-run.
- `supabase/checks/`: a new or extended isolation script (student sees own linked
  note, teacher sees their students' linked notes and not others', neither can edit
  or delete one, the sync's insert/update/delete flow through).
- Docs in the same commit: DATA-MODEL, ARCHITECTURE (migration table, checks table),
  STATUS.

**Portal (`spin-dj-pathways`)**
- `GET /api/v1/notes` and `GET /api/v1/students/me/notes` read WL notes from
  `teacher_note` (a note with no author, or a link, is the WL one) instead of the
  `0065` functions. Labels unchanged: "From WellnessLiving" / "From the studio",
  read-only, no date.
- Edit/Delete never offered on a WL note; the database refuses it anyway.

## Out of scope

- Author and written date of a WL note — WL does not return them.
- Writing notes back to WellnessLiving.
- GHL or any other note source.
- `0063` being numbered twice (`sync_queue_retention` and
  `teacher_note_private_student_tag`) — a separate cleanup.

## Acceptance criteria

- [ ] `0067` applies cleanly on dev and its trailing checks pass; re-running it changes
      nothing.
- [ ] After `0067`, every `wl_client_note` with text whose uid is a student has exactly
      one linked, public, non-deleted `teacher_note` with that text and that student
      (334 student + 5 teacher clients on dev; one per WL note after 0068).
- [ ] A client-list sync pass that adds, edits and removes a note produces the new
      note, the updated body, and the soft-deleted note — and the pass still ends `ok`.
- [ ] A student reads their own WL note and no one else's; a teacher reads the WL notes
      of students they teach and no others; neither can edit or delete one; `anon`
      reads none. Proven by a check script that goes red when the guard is removed.
- [ ] A teacher-written note with no author is refused by the database.
- [ ] The portal's notes tabs show WL notes from `teacher_note`, once each, and no
      longer call the `0065` functions.
- [ ] `npm run verify` passes; docs updated in the same commit.

## Constraints & notes

- WL keys are text (`uid`), never integers.
- The `0066` portal change must already be deployed; this replaces the same two
  routes again.
- Order of release: migration first (it keeps the `0065` functions until the portal
  no longer needs them, if decision 2 is split), or portal and migration together —
  settle in the plan.
- Every existing student note becomes a `teacher_note` row the student reads; the
  studio accepted that visibility on 19 Oct 2026 (`0065`).

## Resources

None yet.
