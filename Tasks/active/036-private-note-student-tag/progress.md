# Progress: Private notes — optionally tag a student

## Checklist

- [x] `0063`: relax the kind check; roster rule whenever a student is set; trailing checks
- [x] `teacher_note_isolation.sql`: section I (tagged private note hidden from the student; roster rule; public still needs a student)
- [x] DATA-MODEL.md + ARCHITECTURE.md (migration row, checks row)
- [x] Portal API: `student_id` accepted on private notes; explicit `visibility = 'public'` on the student read
- [x] Portal UI: optional student dropdown on Private Notes, name on private cards, hint
- [x] docs-current passes; portal `next build` green
- [ ] Apply `0063` in the SQL editor (read the OK notices)
- [ ] Run `teacher_note_isolation.sql`; mutation-check section I (recreate the student policy without `visibility = 'public'` and watch I7 and I8 go red)

## Last step

Built and verified as far as is possible without the database. Waiting on `0063` being
applied by hand in the Supabase SQL editor.

## Blockers

None. Apply `0063` before using the portal change: until then a private note that
names a student is refused by the old `teacher_note_kind_check` (the API returns the
database's message as a 400).

## Log

### 2026-10-14
- Task created from the user's request. `0056` made a private note carry no student
  (`teacher_note_kind_check`); this relaxes that for private notes only.
- Noted that the student read policy's `visibility = 'public'` guard becomes the
  sole protection once a private note can carry a student id, so its trailing check
  and a regression test say so.
- Task id 035 was already taken by an unrelated `035-sync-queue-retention`, so this
  is 036. Migrations 0059-0062 are taken (0060 unused), so this is 0063.
- Built `0063`: the kind check is now `visibility = 'private' or student_id is not
  null`; the INSERT and UPDATE `with check` are `student_id is null or
  app.teaches_student(student_id)`, so the roster rule follows the student rather
  than the kind. `teacher_note_student_select` is untouched on purpose. Trailing
  checks assert the relaxed constraint, the roster rule on both write policies with
  no reference to `visibility`, the student policy still being public-only, no
  inline table read, and exactly four policies.
- Re-run hazard recorded in the migration and docs: re-running `0056` recreates its
  older insert/update policies and undoes `0063`; re-run `0063` after it.
- Isolation check section I: tina tags a private note with alice and writes a public
  control note to alice; alice sees only the control (by body and by id), trevor sees
  neither, a private note naming carol (off tina's roster) is refused on insert and on
  re-tag, and a public note with no student is still refused. The "private has no
  student" line in the header was corrected.
- Portal: `POST /api/v1/notes` no longer rejects `student_id` on a private note (the
  "A private note has no student" 400 is gone) and passes it through for both kinds;
  the refusal message no longer says "public". `GET /api/v1/students/me/notes` now
  filters `visibility = 'public'` explicitly, because the old guarantee (a private
  note has no student id and cannot match) no longer holds.
- UI: the Private Notes form has the student dropdown, default "No specific
  student", with a hint ("Only you can see this note, even though it's about X").
  Private cards read "Private · Name", or "Private · a student" if the student has
  left the teacher's roster. The selection is cleared when switching between the
  Private and Public views, so a student chosen for a public note cannot silently tag
  the next private one.
- Checks run: docs-current (4 tests) passes; portal `next build` green. The SQL
  itself has not been run — the repo has no way to run DDL — so section I and the
  trailing checks are unexecuted until the migration is applied.
