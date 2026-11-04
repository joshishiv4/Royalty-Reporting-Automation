-- =============================================================================
-- 0067  WellnessLiving profile notes become teacher_note rows (task 037)
--
-- Decided 28 Oct 2026 (the studio, in conversation). Until now a WL profile note
-- (0064, public.wl_client_note) reached the portal through two side functions
-- (0065) and the portal merged them with app.teacher_note itself. From here the
-- note IS a teacher_note row, and the sync keeps it so by trigger:
--
--   * a STUDENT's note  -> a PUBLIC note to that student, with no author;
--   * a TEACHER's note  -> a PRIVATE note authored by that teacher, no student.
--     The teacher reads what staff wrote about them in WL - accepted knowingly;
--   * anyone else (no identity, or an empty note) -> nothing.
--
-- -----------------------------------------------------------------------------
-- WHERE THE WL KEY LIVES: ON A LINK, NEVER ON THE NOTE
-- -----------------------------------------------------------------------------
-- app.teacher_note_link carries the note id and the WL uid, nothing else - the
-- cohort_link / session_link / attendance_link pattern (0041, 0043). PRESENCE OF
-- A LINK IS THE PROVENANCE. A `source` column or an `is_wl_note` flag was
-- considered and rejected: it would sit beside the link as a second answer, and
-- the two could disagree. No organization_id on the link either (0048): its
-- organization is its note's.
--
-- The link holds the uid, not wl_client_note.id. The uid is WL's own stable key;
-- a wl_client_note row is deleted when WL says has_note: false and created anew
-- when the note comes back, so its id does not survive. No foreign key to
-- wl_client_note for the same reason - the row goes, the link stays, and the
-- note is soft-deleted.
--
-- -----------------------------------------------------------------------------
-- WHAT HAD TO CHANGE ON teacher_note, AND WHY
-- -----------------------------------------------------------------------------
--   1. author_teacher_id becomes nullable. WL gives no author (STATUS, blocked 5).
--      A null author is allowed ONLY on a linked note - a deferred constraint
--      trigger checks it at commit, so a note written with no author and no link
--      is refused even through the service role. (Through the API it was already
--      refused: the insert policy needs author = current_teacher_id().)
--   2. A linked note is read-only through the API. A student's WL note already
--      fails the author policy (null author); a teacher's own WL note has an
--      author, so teacher_note_author_update gains `not app.is_linked_note(id)`.
--      Soft delete is an UPDATE (0058), so this closes delete too.
--   3. 0057's revision trigger writes author_teacher_id (NOT NULL) on every body
--      change. A WL note's body changes whenever staff edit it in WL, so without
--      a guard the sync would fail on the first edited note. It now skips linked
--      notes: WL is their history, not us.
--   4. A teacher reads the linked notes of students they teach - a new SELECT
--      policy. Like every policy since 0055 it names no table, only definer
--      helpers (the 42P17 recursion rule).
--
-- created_at of a WL note is when this trigger first copied it. It is NOT when
-- the note was written - WL does not say - and the portal shows WL notes with no
-- date (0066).
--
-- The two 0065 functions are dropped: the notes are now read from teacher_note,
-- and keeping both would show every note twice. RELEASE ORDER: deploy the portal
-- change that reads teacher_note FIRST, then apply this. The other way round the
-- portal calls functions that no longer exist.
--
-- RE-RUNNING 0063 (or 0056) RECREATES teacher_note_author_update WITHOUT the
-- linked-note guard. Re-run 0067 after either.
--
-- Requires 0055, 0057, 0058, 0063, 0064. Safe to re-run: every note is synced by
-- one idempotent function, so the backfill can run any number of times.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The link
-- -----------------------------------------------------------------------------
create table if not exists app.teacher_note_link (
  teacher_note_id uuid primary key
                  references app.teacher_note (id) on delete cascade,
  -- WellnessLiving's client uid. Text, never an integer: a leading zero is data.
  uid             text not null
                  constraint teacher_note_link_uid_unique unique
);

comment on table app.teacher_note_link is
  'Provenance of a teacher_note copied from a WellnessLiving profile note '
  '(public.wl_client_note), keyed by WL uid. A note with a link came from WL and '
  'is read-only; a note without one was written in the portal. No other columns - '
  'see 0067.';

alter table app.teacher_note_link enable row level security;

-- The portal needs to know WHICH visible notes came from WL, and nothing else.
-- So: the note id only, never the uid, and a policy that hides nothing - a note
-- id is an unguessable uuid, and knowing one is WL-linked reveals nothing.
revoke all on app.teacher_note_link from anon, authenticated;
grant select (teacher_note_id) on app.teacher_note_link to authenticated;
grant all on app.teacher_note_link to service_role;

drop policy if exists teacher_note_link_select on app.teacher_note_link;
create policy teacher_note_link_select on app.teacher_note_link
  for select to authenticated
  using (true);


-- -----------------------------------------------------------------------------
-- 2. The helper every guard uses
-- -----------------------------------------------------------------------------
-- Definer, so a policy can ask "is this note linked" without reading another
-- policied table itself (0055's 42P17).
create or replace function app.is_linked_note(p_note_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.teacher_note_link l where l.teacher_note_id = p_note_id)
$$;

comment on function app.is_linked_note(uuid) is
  'Whether a teacher_note came from WellnessLiving (has a teacher_note_link). '
  'Definer, for use inside policies - 0067.';

revoke execute on function app.is_linked_note(uuid) from public, anon;
grant  execute on function app.is_linked_note(uuid) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. teacher_note: an author may be missing, but only on a linked note
-- -----------------------------------------------------------------------------
alter table app.teacher_note
  alter column author_teacher_id drop not null;

comment on column app.teacher_note.author_teacher_id is
  'The teacher who wrote the note. NULL only for a WellnessLiving note about a '
  'student (linked, 0067) - WL does not say who wrote it.';

-- Deferred to commit: the sync inserts the note, then its link, in one transaction.
create or replace function public.teacher_note_author_or_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.author_teacher_id is null
     and not exists (select 1 from app.teacher_note_link l where l.teacher_note_id = new.id)
  then
    raise exception 'teacher_note % has no author and is not a WellnessLiving note', new.id
      using errcode = '23502';
  end if;
  return null;
end
$$;

drop trigger if exists teacher_note_author_or_link on app.teacher_note;
create constraint trigger teacher_note_author_or_link
  after insert or update of author_teacher_id on app.teacher_note
  deferrable initially deferred
  for each row execute function public.teacher_note_author_or_link();


-- -----------------------------------------------------------------------------
-- 4. 0057's revision history skips linked notes
-- -----------------------------------------------------------------------------
create or replace function public.record_teacher_note_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A WellnessLiving note's history is WL's, and it may have no author, which the
  -- revision row requires. Skipping it is what lets the sync edit it (0067).
  if old.body is distinct from new.body
     and not exists (select 1 from app.teacher_note_link l where l.teacher_note_id = old.id)
  then
    insert into app.teacher_note_revision (note_id, author_teacher_id, body, revised_at)
    values (old.id, old.author_teacher_id, old.body, now());
  end if;
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. Policies: a linked note is read-only; a teacher reads their students' WL notes
-- -----------------------------------------------------------------------------
-- 0063's update policy, plus "not linked". Nothing else changes.
drop policy if exists teacher_note_author_update on app.teacher_note;
create policy teacher_note_author_update on app.teacher_note
  for update to authenticated
  using (
    teacher_note.author_teacher_id = app.current_teacher_id()
    and not app.is_linked_note(teacher_note.id)
  )
  with check (
    teacher_note.author_teacher_id = app.current_teacher_id()
    and not app.is_linked_note(teacher_note.id)
    and (
      teacher_note.student_id is null
      or app.teaches_student(teacher_note.student_id)
    )
  );

-- What 0065's my_students_wl_notes() gave a teacher: the WL note of each student
-- they teach. Public and live only, as the student's own read is.
drop policy if exists teacher_note_wl_student_select on app.teacher_note;
create policy teacher_note_wl_student_select on app.teacher_note
  for select to authenticated
  using (
    teacher_note.visibility = 'public'
    and teacher_note.deleted_at is null
    and app.is_linked_note(teacher_note.id)
    and app.teaches_student(teacher_note.student_id)
  );


-- -----------------------------------------------------------------------------
-- 6. One note, synced by one function - used by the trigger AND the backfill
-- -----------------------------------------------------------------------------
-- Idempotent: run it twice for the same uid and the second run changes nothing.
create or replace function public.sync_wl_note_to_teacher_note(p_uid text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text       text;
  v_note       uuid;
  v_student    uuid;
  v_teacher    uuid;
  v_identities int;
begin
  select nullif(btrim(n.note_text), '') into v_text
    from public.wl_client_note n where n.uid = p_uid;

  select l.teacher_note_id into v_note
    from app.teacher_note_link l where l.uid = p_uid;

  -- No note in WL any more (row deleted on has_note: false), or WL's "Note with
  -- no text": the copy is soft-deleted, never destroyed (0058).
  if v_text is null then
    if v_note is not null then
      update app.teacher_note set deleted_at = now()
       where id = v_note and deleted_at is null;
    end if;
    return;
  end if;

  if v_note is not null then
    update app.teacher_note
       set body = v_text, deleted_at = null
     where id = v_note
       and (body is distinct from v_text or deleted_at is not null);
    return;
  end if;

  -- First sighting: who is this? Exactly one identity, or nothing - the same rule
  -- identity_for_email() keeps (0054). Measured 28 Oct 2026: no uid has two.
  select count(*), max(i.student_id::text)::uuid, max(i.teacher_id::text)::uuid
    into v_identities, v_student, v_teacher
    from app.identity i where i.uid = p_uid;

  if v_identities <> 1 then
    return;
  end if;

  if v_student is not null then
    insert into app.teacher_note (author_teacher_id, student_id, visibility, body)
    values (null, v_student, 'public', v_text)
    returning id into v_note;
  elsif v_teacher is not null then
    insert into app.teacher_note (author_teacher_id, student_id, visibility, body)
    values (v_teacher, null, 'private', v_text)
    returning id into v_note;
  else
    return;
  end if;

  insert into app.teacher_note_link (teacher_note_id, uid) values (v_note, p_uid);
end
$$;

comment on function public.sync_wl_note_to_teacher_note(text) is
  'Makes app.teacher_note agree with public.wl_client_note for one WL uid: a '
  'student''s note -> public note to them, no author; a teacher''s -> their own '
  'private note; gone or empty -> soft-deleted. Idempotent. Called by the '
  'wl_client_note trigger and by 0067''s backfill.';

revoke execute on function public.sync_wl_note_to_teacher_note(text) from public, anon, authenticated;


create or replace function public.wl_client_note_to_teacher_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The sync upserts every note on every pass. The function writes only when
  -- something actually changed, so an unchanged night touches no teacher_note.
  perform public.sync_wl_note_to_teacher_note(coalesce(new.uid, old.uid));
  return null;
end
$$;

-- Trigger BEFORE backfill: a note written between the two is caught by the
-- trigger, and the backfill skips what is already linked (0040's reasoning,
-- from the safe side).
drop trigger if exists wl_client_note_to_teacher_note on public.wl_client_note;
create trigger wl_client_note_to_teacher_note
  after insert or update or delete on public.wl_client_note
  for each row execute function public.wl_client_note_to_teacher_note();


-- -----------------------------------------------------------------------------
-- 7. Backfill every note that exists today
-- -----------------------------------------------------------------------------
select public.sync_wl_note_to_teacher_note(n.uid) from public.wl_client_note n;


-- -----------------------------------------------------------------------------
-- 8. The 0065 doors are closed: the notes are read from teacher_note now
-- -----------------------------------------------------------------------------
drop function if exists app.my_students_wl_notes();
drop function if exists app.my_wl_note();


-- -----------------------------------------------------------------------------
-- Trailing checks
-- -----------------------------------------------------------------------------
do $$
declare
  n        int;
  expected int;
begin
  -- Every student's or teacher's note with text has exactly one live linked note.
  select count(*) into expected
    from public.wl_client_note w
    join app.identity i on i.uid = w.uid
   where nullif(btrim(w.note_text), '') is not null
     and (i.student_id is not null or i.teacher_id is not null)
     and (select count(*) from app.identity i2 where i2.uid = w.uid) = 1;

  select count(*) into n
    from app.teacher_note_link l
    join app.teacher_note t on t.id = l.teacher_note_id
   where t.deleted_at is null;

  if n <> expected then
    raise exception '0067: % live linked notes, expected %', n, expected;
  end if;
  raise notice 'OK: % WellnessLiving notes linked', n;

  -- No portal-written note lost its author.
  select count(*) into n
    from app.teacher_note t
   where t.author_teacher_id is null
     and not exists (select 1 from app.teacher_note_link l where l.teacher_note_id = t.id);
  if n <> 0 then
    raise exception '0067: % note(s) with no author and no link', n;
  end if;

  -- The update policy keeps the linked-note guard (re-running 0063 removes it).
  select count(*) into n from pg_policies
   where schemaname = 'app' and tablename = 'teacher_note'
     and policyname = 'teacher_note_author_update'
     and qual like '%is_linked_note%' and with_check like '%is_linked_note%';
  if n <> 1 then
    raise exception '0067: teacher_note_author_update lacks the linked-note guard - re-run 0067';
  end if;

  -- No policy added here reads a table inline (0055's 42P17 rule).
  select count(*) into n from pg_policies
   where schemaname = 'app' and tablename = 'teacher_note'
     and policyname in ('teacher_note_author_update', 'teacher_note_wl_student_select')
     and (coalesce(qual, '') ~* '\m(from|join)\M' or coalesce(with_check, '') ~* '\m(from|join)\M');
  if n <> 0 then
    raise exception '0067: a teacher_note policy reads a table inline';
  end if;

  -- The student's own read is untouched: public, theirs, live.
  select count(*) into n from pg_policies
   where schemaname = 'app' and tablename = 'teacher_note'
     and policyname = 'teacher_note_student_select'
     and qual like '%public%' and qual like '%deleted_at%';
  if n <> 1 then
    raise exception '0067: teacher_note_student_select changed';
  end if;

  -- The link exposes the note id only, and anon nothing.
  if has_column_privilege('authenticated', 'app.teacher_note_link', 'uid', 'select') then
    raise exception '0067: authenticated can read teacher_note_link.uid';
  end if;
  if has_table_privilege('anon', 'app.teacher_note_link', 'select') then
    raise exception '0067: anon can read teacher_note_link';
  end if;
  if has_table_privilege('authenticated', 'app.teacher_note_link', 'insert')
     or has_table_privilege('authenticated', 'app.teacher_note_link', 'update')
     or has_table_privilege('authenticated', 'app.teacher_note_link', 'delete') then
    raise exception '0067: authenticated can write teacher_note_link';
  end if;

  -- The sync function is not callable through the API.
  if has_function_privilege('authenticated', 'public.sync_wl_note_to_teacher_note(text)', 'execute')
     or has_function_privilege('anon', 'public.sync_wl_note_to_teacher_note(text)', 'execute') then
    raise exception '0067: sync_wl_note_to_teacher_note is callable through the API';
  end if;

  -- 0065's functions are gone.
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app' and p.proname in ('my_wl_note', 'my_students_wl_notes');
  if n <> 0 then
    raise exception '0067: % 0065 note function(s) still exist', n;
  end if;

  -- Both triggers present.
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.wl_client_note'::regclass
                    and tgname = 'wl_client_note_to_teacher_note') then
    raise exception '0067: wl_client_note trigger missing';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'app.teacher_note'::regclass
                    and tgname = 'teacher_note_author_or_link') then
    raise exception '0067: author-or-link constraint trigger missing';
  end if;
end
$$;
