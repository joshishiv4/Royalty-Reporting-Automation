-- =============================================================================
-- 0072  lesson_signoff: where its signed PDF was filed in Google Drive
-- =============================================================================
--
-- Task 038, phase 3: file each signed lesson's PDF into the studio's month/FI
-- folders.
--
-- WHO MAKES THE PDF. Jotform does, not us. Its Google Drive integration drops a
-- PDF for every submission into ONE flat folder, named by submission id
-- ("<submission id>.pdf", seen 25 Nov 2026), and it is the PDF template the
-- user set up without the hidden Lesson ID row. The public API has no PDF
-- endpoint (WL-API-NOTES.md, Jotform section), so this is the only route to it.
-- Phase 3 MOVES and RENAMES that file; it never creates one.
--
-- WHY NOT JOTFORM'S OWN FOLDER SETTINGS. Checked in its Workflow builder with the
-- user, 25 Nov 2026: one folder name typed as fixed text, an optional subfolder
-- per submission, and the PDF takes the subfolder's name. It cannot build
-- "<MONTH> / <MONTH> - UNMERGED / <FI> - <MONTH> / <name>.pdf", and it files every
-- submission - tests and edited links included. Only lessons phase 2 judged
-- 'signed' are filed; everything else stays in the drop folder.
--
-- CRASH ORDER. The move, the rename and a tag (appProperties lessonSignoffId)
-- are ONE Drive call; the row is written after it. A run that dies in between
-- leaves a moved file and an unfiled row - the next run finds the file by its tag
-- and only records it. Nothing is lost and nothing is moved twice.
--
-- drive_folder_id is the "<FI> - <MONTH>" folder, kept for phase 4 (the month-end
-- merge), which reads every lesson of one folder.
--
-- pdf_missing_reported_at: a signed lesson whose PDF has not arrived 24 hours
-- after signing is emailed to the admin ONCE - that is how a switched-off Jotform
-- integration gets noticed before month end.
--
-- Safe to re-run.
-- =============================================================================

alter table public.lesson_signoff
  add column if not exists drive_file_id           text,
  add column if not exists drive_folder_id         text,
  add column if not exists drive_file_name         text,
  add column if not exists filed_at                timestamptz,
  add column if not exists pdf_missing_reported_at timestamptz;

comment on column public.lesson_signoff.drive_file_id is
  'The Google Drive file id of the signed PDF once filed. Jotform made the file; '
  'phase 3 moved and renamed it. Null until filed.';
comment on column public.lesson_signoff.drive_folder_id is
  'The "<FI> - <MONTH YEAR>" folder the PDF was filed in (inside "<MONTH YEAR> - '
  'UNMERGED"). Phase 4 merges per folder.';
comment on column public.lesson_signoff.drive_file_name is
  'First-Last-MM-DD-YYYY-HHMMAM.pdf. The start time keeps two lessons on one day '
  'apart - the studio''s own names collided (three identical names seen).';
comment on column public.lesson_signoff.filed_at is
  'When phase 3 recorded the filing. Set together with drive_file_id.';
comment on column public.lesson_signoff.pdf_missing_reported_at is
  'When the admin was told this signed lesson''s PDF had not reached Drive 24 hours '
  'after signing. Set once, so the alert is sent once.';

-- A Drive file is filed for one lesson only.
create unique index if not exists lesson_signoff_drive_file_id_key
  on public.lesson_signoff (drive_file_id)
  where drive_file_id is not null;

-- The hourly seed: signed and not yet filed.
create index if not exists lesson_signoff_unfiled_idx
  on public.lesson_signoff (k_business, signed_at)
  where status = 'signed' and filed_at is null;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'lesson_signoff'
       and column_name = 'pdf_missing_reported_at'
  ) then
    raise exception '0072: lesson_signoff.pdf_missing_reported_at was not added';
  end if;
end
$$;
