# Progress: Teacher notes — private (personal) and public (to a student)

## Checklist
*Steps to reach the acceptance criteria. Add, reorder, or expand as work clarifies the plan.*

- [x] Draft `0056_teacher_note.sql` — table, constraint, triggers, 5 RLS policies, grants, trailing checks
- [x] Make `organization_stamp()` SECURITY DEFINER in `0056` (first authenticated-written table; invoker version would `NO_DATA_FOUND` reading `app.organization` under the caller's RLS)
- [x] Write the `supabase/checks/teacher_note_isolation.sql` proof (write-path, as each signed-in user)
- [x] Update DATA-MODEL.md (new "Teacher notes" subsection) and ARCHITECTURE.md (migration row + checks row) — ready for the same commit as `0056`
- [ ] Apply `0056` in the Supabase SQL editor; capture the trailing-check NOTICEs into `resources/`
- [ ] Run `teacher_note_isolation.sql` in the SQL editor; mutation-check each assertion (drop a policy, watch the named line go red)
- [ ] Confirm `0053`/`0055` (`portal_auth_isolation.sql`) still passes unchanged
- [x] Portal: `GET/POST /api/v1/notes`, `PATCH/DELETE /api/v1/notes/[id]`, `GET /api/v1/students/me/notes` via `sessionSupabase()`
- [x] Portal: teacher authoring UI (list, create private/public with roster student picker, edit, delete) — `NotesManager.jsx` on `/teacher`
- [x] Portal: student read-only notes UI grouped by teacher — `/student/notes` + Notes nav tab
- [x] Portal `next build` green (compile + TypeScript) with all three note routes and `/student/notes` present
- [ ] Verify the portal end-to-end once `0056` is applied (sign in as a teacher, write/read/edit/delete; sign in as the student, read)
- [ ] Correct STATUS.md's stale task-032 line and add the notes/first-write-path entry

## Last step
*One line summary of where work paused. Updated whenever a session ends.*

Added edit-version history (`0057` + `teacher_note_revision`, trigger-written, author-read, unforgeable) with a "View history" panel in the teacher UI. Portal `next build` green. Blocked only on applying `0056` then `0057` in the Supabase SQL editor.

## Blockers
*Anything preventing progress. Empty when there are none.*

None. (Teacher auth, the one real dependency, is already in place via migration `0055`.)

## Log
*Append-only chronological record. Newest entries at the bottom.*

### 2026-10-09
- Task created. Scope and the four open decisions settled with the user: private =
  personal/no student; public = to one student; many notes per student (a log);
  edit and delete both allowed.
- Investigated the codebase before drafting: `app.teacher_note` fits the owned-table
  conventions (DATA-MODEL.md); `app.current_teacher_id()`, `app.current_student_id()`
  and `app.teaches_student()` already exist (`0053`/`0055`) and are the only helpers
  the policies need; `sessionSupabase()` is the RLS-enforced client the routes must
  use (not the service-role `supabase.ts`); `app/api/v1/teachers/me/roster/route.ts`
  is the handler pattern to follow.
- Key finding driving the design: this is the database's **first write RLS path** —
  everything to date is `for select` only, and `0055` flagged the first write policy
  as a decision in its own right.
- Wrote `0056_teacher_note.sql`: table + `teacher_note_kind_check` (private⇒no
  student, public⇒student), author/updated triggers, five policies (author SELECT;
  student public SELECT; author-only INSERT/UPDATE/DELETE with the roster rule in
  `with check`), grants, and six trailing self-checks.
- **Discovered and fixed a blocker in the stamp.** `organization_stamp()` (0048)
  was SECURITY INVOKER — fine while only the sync (service_role) wrote. As the first
  `authenticated`-written table, `teacher_note` would hit `NO_DATA_FOUND`: the stamp
  reads `app.organization`, which is RLS-restricted to the caller's memberships, so
  `into strict` no longer means "exactly one org exists". Made it SECURITY DEFINER
  with pinned `search_path` in `0056`, restoring the system-level invariant for any
  writer. No change for the seven tables 0048 stamps (all service_role-written).
  Added a trailing check asserting the definer+search_path.
- Wrote `supabase/checks/teacher_note_isolation.sql` proving the write path by
  doing: tina writes private + public(alice), is refused public(carol, off-roster)
  and a forged-author note; alice sees only the public note and cannot edit it; bob
  and trevor see nothing and cannot edit/delete; tina edits/deletes her own but
  cannot re-point a public note off her roster; anon refused. Rolls back; names the
  policy to drop for each assertion.
- Docs updated in step: ARCHITECTURE.md migration row + checks row; DATA-MODEL.md
  new "Teacher notes, and the first write path (0056)" subsection under Access
  control. Structural tests pass: docs-current (4), app-schema (5),
  no-hardcoded-config (11).
### 2026-10-12
- Added **edit-version history** for both note kinds. `0057` creates
  `app.teacher_note_revision` (child of `teacher_note`, no `organization_id` —
  derived from the note like a `*_link` row), written by a `BEFORE UPDATE` trigger
  (`record_teacher_note_revision`, SECURITY DEFINER) that keeps the OLD body on
  every real text change. RLS: author-reads-only, and **no user write grant** — the
  definer trigger is the single writer, so history can't be forged or rewritten.
  CASCADE from the note. Trailing checks assert the trigger, definer+search_path,
  one SELECT-only policy, and no write grant for `authenticated`.
- Extended `teacher_note_isolation.sql` with section H: an edit records one
  revision holding the pre-edit text; author reads it; a hand-written revision is
  refused; another teacher reads none.
- Portal: `GET /api/v1/notes/[id]/history` (author-only via RLS) and a "View
  history" panel per note in NotesManager — shows Current (from the note) then the
  stored previous versions, newest first; cache invalidated on edit. `next build`
  green, route registered.
- Docs: ARCHITECTURE migration row `0057` + checks-row note; DATA-MODEL history
  subsection. docs-current passes.
- **Decision flagged:** history is **teacher(author)-only**; students still see
  only a public note's current text. Flip = one more SELECT policy on
  `teacher_note_revision` matching the student on `note_id`. Left out on purpose.

- Switched delete to **soft delete** (`0058`). `teacher_note.deleted_at` nullable;
  "delete" is an UPDATE that stamps it, so the row + revision history are kept. The
  **hard-delete path is removed** — dropped `teacher_note_author_delete` and revoked
  DELETE from `authenticated` (else a hard delete would also cascade-erase history);
  `service_role` keeps DELETE. Student policy gains `deleted_at is null`; author
  policy left wide for a future Trash/restore; teacher list filters deleted in the
  handler. Portal: DELETE route now UPDATEs deleted_at; teacher + student GETs
  exclude deleted. Isolation check E3/F3 → soft-delete, added F4 (row retained) and
  F5 (student no longer sees it). Docs + docs-current pass; portal build green.
  **Deleted notes are now retained in the DB, hidden from the UI.** Restore UI not
  built — offered.

### Earlier
- **Decision to flag:** making `organization_stamp()` DEFINER is the one change
  that reaches beyond the new table. It is safe and documented, but it is a shared
  function — surfaced to the user.
- Built the portal side (spin-dj-pathways): three API routes under
  `app/api/v1/notes/` + `app/api/v1/students/me/notes/`, all via `sessionSupabase()`
  (RLS), never the service-role client. Teacher UI `app/teacher/NotesManager.jsx`
  (compose with private/public toggle + roster-sourced student picker, inline edit,
  delete) added as a second card on `/teacher`. Student read-only view
  `app/student/notes/page.jsx` grouped by teacher, plus a Notes nav tab
  (`fixtures.js` NAV_ITEMS, `StudentShell.jsx` TAB_PATH).
- `node_modules` was incomplete (had `next`, no `react`); ran `npm install`, then
  `npm run build` — green: compiled, TypeScript passed, all three note routes and
  `/student/notes` listed. Compile only; runtime test waits on `0056` being applied.
