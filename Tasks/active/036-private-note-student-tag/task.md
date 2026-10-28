---
id: 036
title: Private notes — optionally tag a student, still visible only to the teacher
status: active
priority: medium
depends_on: [033]
created: 2026-10-14
---

# Private notes — optionally tag a student

## Goal

A teacher can choose a student when writing a private note, so they remember who it
is about. The student is optional; a private note with no student works as it does
today.

The note stays private. Only its author can see it. The tagged student can never see
it, and neither can other teachers or students. The tag is a label for the teacher,
not a way to share the note.

This **reverses** a rule from `0056`: "private ⇒ no student". Public notes are
unchanged and still require a student.

## Decisions (from the user, 14 Oct 2026)

- The student is **optional** on a private note.
- The note is visible **only to the author**, as now.
- **Default taken, open to change:** the student picker is limited to the teacher's
  roster (students who attended one of their sessions), and the database enforces
  it, exactly as for public notes. The alternative is any student in the studio.

## Scope

**Database (new migration `0063`)**
- Relax `teacher_note_kind_check`: a private note may have a student or not; a
  public note still requires one.
- Move the roster rule from "public notes only" to "whenever a note names a
  student": the INSERT and UPDATE `with check` become
  `student_id is null or app.teaches_student(student_id)`. (This `is null` is on a
  plain column, not on the identity helpers `0055` warns about.)
- Leave `teacher_note_student_select` alone. Its `visibility = 'public'` guard used
  to be backed up by the kind check (a private note had no student, so it could not
  match). It is now the **only** thing keeping a tagged private note from the
  student, so a trailing check asserts it is still there.
- No change to existing rows (private notes keep no student).
- Add cases to `supabase/checks/teacher_note_isolation.sql`; update DATA-MODEL.md
  and ARCHITECTURE.md in the same change.

**Backend (`spin-dj-pathways`)**
- `POST /api/v1/notes` accepts `student_id` on a private note (it currently rejects
  it: "A private note has no student").
- `GET /api/v1/students/me/notes` filters `visibility = 'public'` explicitly, as
  defence in depth now that a private note can carry the student's id.
- `GET /api/v1/notes` already returns the student name for any note with a student.

**Frontend**
- The Private Notes form gets an optional student dropdown from the roster, default
  "No specific student".
- Private note cards show the student's name ("Private · Alice Smith") or just
  "Private".
- A hint: "Only you can see this note, even though it's about Alice."

## Out of scope

- Changing a note's student after it is created (`PATCH` stays body-only).
- Filtering or searching notes by student.
- Showing private notes to anyone other than the author.

## Acceptance criteria

- [ ] A teacher can save a private note with a student, or without one.
- [ ] A private note tagged with a student never reaches that student: not in
      `/student/notes`, not on the home Coach's Feedback card, not through the API.
- [ ] The database refuses a private note for a student the teacher has not taught.
- [ ] Existing private and public notes behave as before.
- [ ] `teacher_note_isolation.sql` passes with the new cases, and the portal builds.
- [ ] DATA-MODEL.md and ARCHITECTURE.md updated in the same change as `0063`.

## Constraints & notes

- The migration is applied by hand in the Supabase SQL editor. Apply `0063`
  **before** using the portal change: without it, a private note with a student is
  refused by the old `teacher_note_kind_check`.
- Migration numbers `0059`-`0062` are taken; `0060` is unused. `0063` is the next.
- Task id `035` is taken by an unrelated task (`035-sync-queue-retention`).

## Resources

- `resources/` — empty for now.
