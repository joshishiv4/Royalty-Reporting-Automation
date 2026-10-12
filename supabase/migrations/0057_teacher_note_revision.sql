-- =============================================================================
-- 0057  app.teacher_note_revision - the edit history of a note
--
-- WHAT THIS ADDS
--   Every time a note's body is edited, the PREVIOUS text is kept. The current
--   version lives on `teacher_note.body` as before; each earlier version is a row
--   here. A note never edited has no revisions; a note edited three times has
--   three, oldest first by `revised_at`.
--
-- WHY A CHILD TABLE, NOT A JSON COLUMN ON THE NOTE
--   The same reason every other history in this database is a table: a typed row
--   per version is queryable, indexable and has its own row security, where a JSON
--   blob is none of those and grows unbounded on the hot row. It is the shape the
--   `*_link` tables and the transaction reports already use.
--
-- WHY IT CARRIES NO organization_id
--   A revision's organization is its note's, exactly as a `*_link` row's is its
--   owned row's (0048). A column here would be a second answer that could drift, so
--   the revision is reached through `note_id` and nothing else.
--
-- WHO MAY READ IT, AND WHO MAY WRITE IT
--   Read: the AUTHOR only - `teacher_note_revision_author_select`. A note's edit
--   history is an authoring aid, so a student reading a public note still sees only
--   its current text. (If that ever changes, it is one more SELECT policy here,
--   matching the student on `note_id`; it is deliberately not added now.)
--
--   Write: NOBODY, through the API. There is no INSERT/UPDATE/DELETE policy for
--   `authenticated`, so a user cannot forge a version, rewrite one, or erase the
--   record of an edit. History is written ONLY by the trigger below, which is
--   SECURITY DEFINER and so runs as the owner, outside row security. That is the
--   whole point of a history: it is not the editor's to edit.
--
-- Depends on 0056. Safe to re-run.
-- =============================================================================

create table if not exists app.teacher_note_revision (
  id                uuid        primary key default gen_random_uuid(),

  -- The note this is a past version of. CASCADE: deleting a note takes its
  -- history with it - a version of a note that no longer exists is orphaned
  -- data nobody can place, and 0056 lets an author delete their own note.
  note_id           uuid        not null
                    references app.teacher_note (id) on delete cascade,

  -- Denormalised from the note so the read policy is a plain column comparison
  -- and never has to join `teacher_note` (which would drag that table's own
  -- policies in - the 42P17 lesson from 0055). It is the note's author; a note's
  -- author never changes, so this cannot fall out of step with the note.
  author_teacher_id uuid        not null
                    references app.teacher (id) on delete restrict,

  -- The PREVIOUS body - the text as it was before the edit that created this row.
  body              text        not null,

  -- When that version was superseded.
  revised_at        timestamptz not null default now()
);

comment on table app.teacher_note_revision is
  'One prior version of a teacher_note body, written by a trigger on each edit. '
  'Read by the note''s author only; never writable through the API - history is '
  'not the editor''s to edit. See 0057.';

-- Newest-first history for one note is the only read, so index it that way.
create index if not exists teacher_note_revision_note_idx
  on app.teacher_note_revision (note_id, revised_at desc);

-- =============================================================================
-- The trigger that records a version on every real edit
-- =============================================================================
-- SECURITY DEFINER, so it writes history regardless of the caller holding no
-- insert privilege on this table - which is the design: the editor may change the
-- note, but only the system appends the record of it. search_path pinned to '',
-- as every definer function here is, and the body fully-qualifies its names.
--
-- `is distinct from` so a save that did not change the text mints no version -
-- null-safe, though 0056's NOT NULL means body is never null in practice.
create or replace function public.record_teacher_note_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.body is distinct from new.body then
    insert into app.teacher_note_revision (note_id, author_teacher_id, body, revised_at)
    values (old.id, old.author_teacher_id, old.body, now());
  end if;
  return new;
end;
$$;

comment on function public.record_teacher_note_revision() is
  'BEFORE UPDATE on teacher_note: keeps the old body as a revision when the text '
  'changed. DEFINER so history is written although no user may write this table.';

-- BEFORE UPDATE: if 0056's WITH CHECK later rejects the new row, the whole
-- statement - this insert included - rolls back, so history never records an edit
-- that did not happen.
drop trigger if exists teacher_note_record_revision on app.teacher_note;
create trigger teacher_note_record_revision
  before update on app.teacher_note
  for each row execute function public.record_teacher_note_revision();

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table app.teacher_note_revision enable row level security;

-- SELECT only, and only for authenticated. No INSERT/UPDATE/DELETE grant: the
-- trigger (definer) is the single writer, and withholding the privilege is what
-- makes "history is not forgeable" true rather than merely intended. service_role
-- keeps full access for operational reads.
grant select on app.teacher_note_revision to authenticated;
grant select, insert, update, delete on app.teacher_note_revision to service_role;

-- The author reads their own notes' history. current_teacher_id() is NULL for a
-- student and for an unlinked human, and NULL compared with `=` is NULL, never
-- true - so nobody else reads a single row. No `is null` anywhere, the 0055 rule.
drop policy if exists teacher_note_revision_author_select on app.teacher_note_revision;
create policy teacher_note_revision_author_select on app.teacher_note_revision
  for select to authenticated
  using (teacher_note_revision.author_teacher_id = app.current_teacher_id());

-- =============================================================================
-- Trailing checks - run with the migration, read the NOTICEs
-- =============================================================================
do $$
declare
  v_count int;
begin
  -- The trigger must exist, or edits silently keep no history.
  select count(*) into v_count
  from pg_trigger
  where tgrelid = 'app.teacher_note'::regclass
    and tgname = 'teacher_note_record_revision';

  if v_count <> 1 then
    raise exception 'FAIL: teacher_note_record_revision trigger missing';
  end if;
  raise notice 'OK: revision trigger present on teacher_note';

  -- The function must be DEFINER with a pinned search_path, or it cannot write
  -- history past the caller's missing privilege and is an escalation risk.
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'record_teacher_note_revision'
    and p.prosecdef
    and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%';

  if v_count <> 1 then
    raise exception 'FAIL: record_teacher_note_revision must be DEFINER with a pinned search_path';
  end if;
  raise notice 'OK: revision function is definer with search_path pinned';

  -- Exactly one policy, and it must be SELECT. An INSERT/UPDATE/DELETE policy
  -- arriving here would hand the editor the power to rewrite history - the one
  -- thing this table exists to prevent.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app' and tablename = 'teacher_note_revision';

  if v_count <> 1 then
    raise exception 'FAIL: expected exactly 1 policy on teacher_note_revision, found %', v_count;
  end if;

  select count(*) into v_count
  from pg_policies
  where schemaname = 'app' and tablename = 'teacher_note_revision' and cmd <> 'SELECT';

  if v_count <> 0 then
    raise exception 'FAIL: % non-SELECT policy on teacher_note_revision - history must not be writable', v_count;
  end if;
  raise notice 'OK: teacher_note_revision has one SELECT-only policy';

  -- authenticated must NOT hold a write privilege here.
  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'app'
    and table_name = 'teacher_note_revision'
    and grantee = 'authenticated'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE');

  if v_count <> 0 then
    raise exception 'FAIL: authenticated holds % write privilege(s) on teacher_note_revision', v_count;
  end if;
  raise notice 'OK: authenticated cannot write teacher_note_revision';
end $$;
