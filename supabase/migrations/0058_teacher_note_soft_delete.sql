-- =============================================================================
-- 0058  teacher_note: soft delete
--
-- WHAT CHANGES
--   A deleted note is now KEPT, not destroyed. `teacher_note.deleted_at` records
--   when it was deleted; a "delete" is an UPDATE that stamps it, the row and its
--   edit history stay, and every normal read hides it. Before this, DELETE removed
--   the row and CASCADE took its revisions with it - the data was gone.
--
-- THE HARD-DELETE PATH IS REMOVED, NOT LEFT BESIDE THE SOFT ONE
--   0056's `teacher_note_author_delete` policy and the DELETE grant to
--   `authenticated` are dropped. If a hard DELETE stays reachable, "we keep
--   deleted notes" is only true until someone calls it - and a teacher_note_revision
--   row cannot outlive its note (the FK CASCADE), so a hard delete still erases the
--   history this feature exists to preserve. Soft delete is now the ONLY delete a
--   user can perform; `service_role` keeps DELETE for genuine data administration.
--
-- WHO STOPS SEEING A DELETED NOTE
--   Student: enforced IN THE POLICY. `teacher_note_student_select` gains
--   `deleted_at is null`, so a deleted public note vanishes for the student the
--   moment it is stamped, regardless of any handler. (This `is null` is on a plain
--   state column, NOT on the identity helpers 0055 warns against testing for null -
--   that rule is about current_student_id()/current_teacher_id(), untouched here.)
--   Author: the SELECT policy is left wide so a future "Trash"/restore view can
--   read stamped rows; the teacher's normal list filters `deleted_at is null` in the
--   handler instead. Nothing a non-author could see changes.
--
-- SOFT DELETE DOES NOT TOUCH HISTORY. It is an UPDATE of `deleted_at`, not `body`,
-- so 0057's revision trigger (which fires only when the body changes) records
-- nothing - a deletion is not an edit.
--
-- Depends on 0056 and 0057. Safe to re-run.
-- =============================================================================

alter table app.teacher_note
  add column if not exists deleted_at timestamptz;

comment on column app.teacher_note.deleted_at is
  'When the note was soft-deleted, or NULL for a live note. A delete stamps this '
  'rather than removing the row, so the note and its history are retained. Normal '
  'reads exclude stamped rows - see 0058.';

-- Active-note reads are the common path, so index them without the deleted rows.
create index if not exists teacher_note_active_author_idx
  on app.teacher_note (author_teacher_id)
  where deleted_at is null;

create index if not exists teacher_note_active_student_idx
  on app.teacher_note (student_id)
  where student_id is not null and deleted_at is null;

-- -----------------------------------------------------------------------------
-- The student no longer sees a deleted public note
-- -----------------------------------------------------------------------------
-- Recreated (not edited in place - a policy cannot be altered) with the same
-- ownership rule plus the deleted-at guard. The author policy is deliberately not
-- touched: the author may still resolve a stamped row, which is what a restore view
-- would need, and the author's live list filters in the handler.
drop policy if exists teacher_note_student_select on app.teacher_note;
create policy teacher_note_student_select on app.teacher_note
  for select to authenticated
  using (
    teacher_note.visibility = 'public'
    and teacher_note.student_id = app.current_student_id()
    and teacher_note.deleted_at is null
  );

-- -----------------------------------------------------------------------------
-- Remove the hard-delete path for users
-- -----------------------------------------------------------------------------
drop policy if exists teacher_note_author_delete on app.teacher_note;
revoke delete on app.teacher_note from authenticated;

-- =============================================================================
-- Trailing checks
-- =============================================================================
do $$
declare
  v_count int;
begin
  -- The column must exist, or a soft delete has nowhere to record itself.
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'app' and table_name = 'teacher_note' and column_name = 'deleted_at';

  if v_count <> 1 then
    raise exception 'FAIL: teacher_note.deleted_at missing';
  end if;
  raise notice 'OK: teacher_note.deleted_at present';

  -- The student policy must now guard on deleted_at, or a deleted public note
  -- would stay visible to the student it was written to.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app' and tablename = 'teacher_note'
    and policyname = 'teacher_note_student_select'
    and qual like '%deleted_at%';

  if v_count <> 1 then
    raise exception 'FAIL: teacher_note_student_select does not guard on deleted_at';
  end if;
  raise notice 'OK: student read excludes deleted notes';

  -- The hard-delete policy must be gone.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app' and tablename = 'teacher_note'
    and policyname = 'teacher_note_author_delete';

  if v_count <> 0 then
    raise exception 'FAIL: teacher_note_author_delete still present - hard delete is still reachable';
  end if;

  -- authenticated must no longer hold DELETE.
  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'app' and table_name = 'teacher_note'
    and grantee = 'authenticated' and privilege_type = 'DELETE';

  if v_count <> 0 then
    raise exception 'FAIL: authenticated still holds DELETE on teacher_note';
  end if;
  raise notice 'OK: the hard-delete path is removed for authenticated';
end $$;
