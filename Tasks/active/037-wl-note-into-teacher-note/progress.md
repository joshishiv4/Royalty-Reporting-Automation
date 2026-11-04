# Progress: WellnessLiving profile notes into app.teacher_note

## Checklist

- [x] Confirm the PRD and the three open decisions
- [x] `0067`: `teacher_note_link`, nullable author with a linked-only guard, revision trigger skips linked notes
- [x] `0067`: `wl_client_note` trigger (insert / update / delete) + backfill after it
- [x] `0067`: teacher read policy for linked notes via a definer helper; linked notes read-only; drop the `0065` functions
- [x] `0067`: trailing checks
- [x] Check script (`wl_client_note_portal_read.sql`, rewritten for 0067)
- [ ] Mutation-check the script against a real database
- [x] DATA-MODEL, ARCHITECTURE, STATUS
- [x] Portal: both note routes read `teacher_note`, not the `0065` functions; teacher's own WL note labelled "Your profile"
- [x] `npm run verify` (872 passed); portal typecheck (no new errors)
- [ ] Deploy the portal change, THEN apply `0067` on dev, run the check, run a client-list pass

## Last step

Written and verified as far as possible without a database. `0067` has not been run
anywhere. Next: release the portal change, then apply `0067` on dev.

## Blockers

None.

## Log

### 2026-10-28
- Task created from the user's request: WL profile notes into the existing
  `teacher_note`, no new notes table, sync kept by trigger.
- Decided with the user: provenance by a link table (`teacher_note_link`), not a
  `source` column or boolean on `teacher_note`, matching `cohort_link` /
  `session_link` / `attendance_link`. Migrations stay in Royalty Reporting.
- Measured on dev: 339 notes → 334 students, 5 teachers. (First counted as 243/5/91 - wrong: PostgREST capped the identity read at 1,000 rows.)
- Found while scoping: `0057`'s revision trigger writes `author_teacher_id` NOT NULL
  on every body change, so it must skip linked notes or the sync fails on the first
  edited WL note.
- Decisions confirmed: teacher's WL note → their private note; `0065` functions
  dropped; `created_at` = copy time, no date shown.
- Decision 1 means a linked note can have an author, so the author update policy
  would let a teacher edit their own WL note. Added `not app.is_linked_note(id)`.
- Backfill runs AFTER the trigger is created (safe either way, since the sync
  function is idempotent; this order loses nothing written in between).
- Written: `0067_teacher_note_wl_link.sql`; check script rewritten; docs; portal
  routes on `spin-dj-pathways` branch `features/wl-note-into-teacher-note` (stacked
  on `features/drop-wl-note-seen-at`, which is not yet pushed).
- `0067` found applied on dev (trigger present, 339 links). The client-list pass ran with it.
- One WL note per row (`0068`, decided with the user): WL joins a profile's notes
  with ", " - 164 of 339 clients have several, 676 notes. Split only at
  `</html>, `; a plain-text tail (29 contain ", ") stays one note. Identity is a
  hash of the note (`note_key`), not its position, so a new note does not make
  the others look edited. Sync writes a page via `replace_wl_client_notes`.
  `teacher_note_link` keyed (uid, note_key) + `position`. Tests mutation-checked:
  splitting on every comma (6 red), no repeat suffix (1 red), has_note false not
  replaced (3 red). `0068` not yet applied.

