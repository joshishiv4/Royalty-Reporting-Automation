-- =============================================================================
-- 0056  app.teacher_note - and the FIRST WRITE POLICIES in this database
--
-- WHAT THIS ADDS
--   One portal-owned table for a teacher's notes, and the first INSERT / UPDATE /
--   DELETE row-security policies anywhere in this project. Every policy before
--   this one - the five in 0053, the six in 0055 - is `for select`. 0055 said why
--   that line mattered: "This database has no write policy at all, and the first
--   one is a larger argument than a migration should settle on its way past." This
--   is that argument, made on purpose and on its own.
--
-- THE TWO KINDS OF NOTE, AND WHO READS EACH (decided with the studio 9 Oct 2026)
--   private - the teacher's OWN note. Personal, attached to no student, and read
--             by its author alone. Nobody else, student or teacher, ever sees it.
--   public  - a note ABOUT one student the teacher taught. Read by its author AND
--             by that one student. No other student, no other teacher.
--
--   The difference is carried by `visibility` together with `student_id`, and a
--   single CHECK constraint binds the two so the pair can never contradict the
--   kind: a private note has no student, a public note names exactly one.
--
-- WHY THE ROSTER RULE IS A WRITE-TIME RULE ONLY
--   A teacher may only ADDRESS a public note to a student app.teaches_student()
--   says they taught - enforced in the INSERT/UPDATE `with check`. The STUDENT's
--   read policy does NOT re-check it: it matches on `student_id` alone. The roster
--   is attendance-derived and shifts over time; a note once sent to a student
--   stays theirs to read. Enforcing the roster at read time would make a student's
--   own notes blink out of existence when an attendance row changes months later,
--   which is nobody's intent. So: who you may write to is checked when you write;
--   what a student may read is simply what was addressed to them.
--
-- NO POLICY HERE NAMES A TABLE. Each is a column comparison or a call to a
-- SECURITY DEFINER helper from 0053/0055 (current_teacher_id, current_student_id,
-- teaches_student). That is the rule 0055 arrived at the hard way, after inline
-- subqueries deadlocked the policy graph with 42P17. `teacher_note` is read by no
-- other table's policy, so it introduces no cycle of its own either - but the rule
-- is kept because it is the rule, not because today happens to be safe.
--
-- Depends on 0048 (organization_stamp), 0053 (current_student_id) and 0055
-- (current_teacher_id, teaches_student). Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The table
-- -----------------------------------------------------------------------------
-- Portal-owned, so it carries NO WellnessLiving field and lives in `app` - the
-- standing rule for every owned table (DATA-MODEL.md, "The role tables hold no
-- WellnessLiving field"). Singular name, like every neighbour, because
-- raw_link.table_name stores table names as data (0048).
--
-- No `synced_at`. That column answers "when was this last read back from the
-- source", and this table HAS no source - nothing syncs a note from WellnessLiving
-- or anywhere else. created_at and updated_at are the whole story.
create table if not exists app.teacher_note (
  id                uuid        primary key default gen_random_uuid(),

  -- Stamped by the trigger below, never defaulted - the 0048 rule. NOT NULL is
  -- made real at the end of the create, because the stamp fills it.
  organization_id   uuid        not null
                    references app.organization (id) on delete restrict,

  -- The author. on delete restrict, like everything in 0048: nothing in this
  -- system deletes a human (0027), and a note whose author vanished is a record
  -- nobody can account for.
  author_teacher_id uuid        not null
                    references app.teacher (id) on delete restrict,

  -- The subject, for a public note. NULL for a private one - that is the entire
  -- distinction, enforced by teacher_note_kind_check below. on delete restrict for
  -- the same reason as the author.
  student_id        uuid
                    references app.student (id) on delete restrict,

  -- TEXT with a CHECK, not an enum - a third kind added later must not need an
  -- ALTER TYPE while rows are being written (the 0048 convention for `role`).
  visibility        text        not null,

  body              text        not null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint teacher_note_visibility_check
    check (visibility in ('private', 'public')),

  -- A note with no words is a mistake, not a case. btrim so whitespace does not
  -- pass for content.
  constraint teacher_note_body_not_empty
    check (length(btrim(body)) > 0),

  -- THE RULE, IN ONE LINE. private => no student; public => exactly one student.
  -- Neither application code nor a policy can produce a row that disagrees with
  -- its own kind, because the database refuses it.
  constraint teacher_note_kind_check
    check (
      (visibility = 'private' and student_id is null) or
      (visibility = 'public'  and student_id is not null)
    )
);

comment on table app.teacher_note is
  'A teacher''s note. private: personal, no student, author reads it alone. '
  'public: about one student the teacher taught, read by author and that student. '
  'Portal-owned, no WellnessLiving field. The first table in this database with '
  'write RLS policies - see 0056.';

comment on column app.teacher_note.student_id is
  'The subject of a public note; NULL for a private one. teacher_note_kind_check '
  'ties this to visibility so the pair cannot contradict the kind.';

-- Indexes for the two reads the policies drive: a teacher listing their own, and
-- a student reading those addressed to them. The organization_id index matches
-- the 0048 convention for every owned table.
create index if not exists teacher_note_author_idx
  on app.teacher_note (author_teacher_id);

create index if not exists teacher_note_student_idx
  on app.teacher_note (student_id)
  where student_id is not null;

create index if not exists teacher_note_organization_idx
  on app.teacher_note (organization_id);

-- -----------------------------------------------------------------------------
-- organization_stamp() becomes SECURITY DEFINER, because this is the first table
-- an ORDINARY USER inserts into
-- -----------------------------------------------------------------------------
-- 0048 wrote `organization_stamp()` as SECURITY INVOKER - the default - and that
-- was correct for every table it stamped, because all seven are written only by
-- the sync, which runs as `service_role` and bypasses RLS. `teacher_note` is the
-- first table an `authenticated` user writes, and that breaks the invoker version:
--
--   The stamp runs `select id into strict from app.organization where is_active`.
--   `app.organization` has RLS with a membership policy (0053), so as the CALLER
--   the teacher sees only the org(s) they belong to - and the `into strict`
--   stops meaning "exactly one organization EXISTS". It would raise NO_DATA_FOUND
--   for a caller with no membership, and - worse - it would silently PASS when a
--   second organization exists but the caller belongs to only one, filing the row
--   under whichever org the caller can see. The loud-failure guarantee 0048 built
--   `into strict` for is a SYSTEM invariant, and a system invariant must not be
--   evaluated through one caller's row-security view.
--
-- SECURITY DEFINER restores the original meaning: the function reads the whole
-- `app.organization` table as its owner, so `into strict` again fails loudly the
-- day a second active organization exists, no matter who is inserting. search_path
-- is pinned to '' for the reason every definer function in 0053/0055 pins it - an
-- unpinned search_path on a definer function lets a caller who can create a schema
-- shadow a table name. The body already fully-qualifies `app.organization`, so the
-- empty search_path changes nothing it resolves.
--
-- This changes NOTHING for the seven tables 0048 stamps: they are written by
-- `service_role`, which bypassed RLS as invoker and runs as the owner as definer -
-- the same full view of `app.organization` either way.
create or replace function public.organization_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if new.organization_id is null then
    select id into strict v_org
      from app.organization
     where is_active;

    new.organization_id := v_org;
  end if;

  return new;
end;
$$;

comment on function public.organization_stamp() is
  'Fills organization_id on an application row that did not name one. Raises '
  'rather than guessing once a second organization exists - see 0048. SECURITY '
  'DEFINER since 0056, so the single-organization invariant is read as the owner '
  'and not through an authenticated writer''s RLS view of app.organization.';

-- -----------------------------------------------------------------------------
-- Triggers: the organization stamp and updated_at, exactly as every owned table
-- -----------------------------------------------------------------------------
-- A note's author and subject are both already in the one organization, so the
-- stamp has nothing more to resolve here.
drop trigger if exists teacher_note_organization_stamp on app.teacher_note;
create trigger teacher_note_organization_stamp
  before insert on app.teacher_note
  for each row execute function public.organization_stamp();

drop trigger if exists teacher_note_set_updated_at on app.teacher_note;
create trigger teacher_note_set_updated_at
  before update on app.teacher_note
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Row Level Security - the first write policies in this database
-- =============================================================================
alter table app.teacher_note enable row level security;

-- GRANTS FIRST, because a policy without one fails `permission denied`, which
-- reads like a policy bug and is not (0053/0055). 0047 gave the app tables to
-- service_role; 0053 granted SELECT to authenticated on the read tables. This
-- table is the first that authenticated may also write, so the grant says so.
grant select, insert, update, delete on app.teacher_note to authenticated;
grant select, insert, update, delete on app.teacher_note to service_role;

-- --- SELECT ------------------------------------------------------------------
-- The author sees every note they wrote, of either kind. current_teacher_id() is
-- NULL for a student and for an unlinked human, and NULL compared with `=` yields
-- NULL, never true - so this returns nothing to a non-author. There is no
-- `is null` anywhere in this file, which is the single line 0055 called the most
-- important in its own: one such test would open every row to everyone.
drop policy if exists teacher_note_author_select on app.teacher_note;
create policy teacher_note_author_select on app.teacher_note
  for select to authenticated
  using (teacher_note.author_teacher_id = app.current_teacher_id());

-- A student sees the PUBLIC notes addressed to them, and nothing else. Not
-- private notes (a student is never their subject - the kind check guarantees
-- student_id is null there, so this cannot match one even by accident), and not
-- another student's. current_student_id() is NULL for a teacher, so a teacher
-- reads nothing THROUGH THIS policy - their own notes come from the author policy
-- above, and the two are OR'd.
drop policy if exists teacher_note_student_select on app.teacher_note;
create policy teacher_note_student_select on app.teacher_note
  for select to authenticated
  using (
    teacher_note.visibility = 'public'
    and teacher_note.student_id = app.current_student_id()
  );

-- --- INSERT ------------------------------------------------------------------
-- You may only write a note as yourself, and may only ADDRESS a public note to a
-- student you taught. A private note (student_id null) needs no roster check -
-- there is no one it is about. teaches_student() is FALSE for a student caller and
-- for a teacher who never taught that student, so the roster rule is the database
-- refusing the row, not a handler remembering to.
drop policy if exists teacher_note_author_insert on app.teacher_note;
create policy teacher_note_author_insert on app.teacher_note
  for insert to authenticated
  with check (
    teacher_note.author_teacher_id = app.current_teacher_id()
    and (
      teacher_note.visibility = 'private'
      or app.teaches_student(teacher_note.student_id)
    )
  );

-- --- UPDATE ------------------------------------------------------------------
-- `using` decides which rows you may target - your own. `with check` decides what
-- the row may become - still yours, and if public still addressed to a student you
-- taught. Both halves are needed: `using` alone would let you rewrite your note to
-- belong to someone else, and `with check` alone would let you target a note that
-- was never yours.
drop policy if exists teacher_note_author_update on app.teacher_note;
create policy teacher_note_author_update on app.teacher_note
  for update to authenticated
  using (teacher_note.author_teacher_id = app.current_teacher_id())
  with check (
    teacher_note.author_teacher_id = app.current_teacher_id()
    and (
      teacher_note.visibility = 'private'
      or app.teaches_student(teacher_note.student_id)
    )
  );

-- --- DELETE ------------------------------------------------------------------
-- Your own, and only your own.
drop policy if exists teacher_note_author_delete on app.teacher_note;
create policy teacher_note_author_delete on app.teacher_note
  for delete to authenticated
  using (teacher_note.author_teacher_id = app.current_teacher_id());

-- =============================================================================
-- Trailing checks - run with the migration, read the NOTICEs
-- =============================================================================
-- The Supabase SQL editor does not surface NOTICEs, so every failure travels in
-- the closing exception as well (the 0053 lesson).
do $$
declare
  v_count int;
begin
  -- The kind check must exist - it is the whole private/public rule. A table
  -- created without it would accept a public note with no student, or a private
  -- note about one, and the policies would then leak or hide the wrong rows.
  select count(*) into v_count
  from pg_constraint
  where conname = 'teacher_note_kind_check'
    and conrelid = 'app.teacher_note'::regclass;

  if v_count <> 1 then
    raise exception 'FAIL: teacher_note_kind_check missing';
  end if;
  raise notice 'OK: teacher_note_kind_check present';

  -- organization_stamp must now be SECURITY DEFINER with a pinned search_path, or
  -- an authenticated teacher's insert reads app.organization through their own RLS
  -- view and the single-org invariant stops meaning what 0048 built it to mean.
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'organization_stamp'
    and p.prosecdef
    and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%';

  if v_count <> 1 then
    raise exception 'FAIL: organization_stamp must be SECURITY DEFINER with a pinned search_path';
  end if;
  raise notice 'OK: organization_stamp is definer with search_path pinned';

  -- Both triggers must be attached, or a note lands with no organization (the
  -- stamp) or a frozen updated_at (the timestamp).
  select count(*) into v_count
  from pg_trigger
  where tgrelid = 'app.teacher_note'::regclass
    and tgname in ('teacher_note_organization_stamp', 'teacher_note_set_updated_at');

  if v_count <> 2 then
    raise exception 'FAIL: expected 2 triggers on teacher_note, found %', v_count;
  end if;
  raise notice 'OK: organization-stamp and updated-at triggers present';

  -- Exactly five policies, and NONE may read a table inline - the 42P17 rule from
  -- 0055. A policy expression mentioning `app.` is reading a table whose own
  -- policies may read back; the definer helpers exist so this can be asserted.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app'
    and tablename = 'teacher_note'
    and qual like '%FROM app.%';

  if v_count <> 0 then
    raise exception 'FAIL: % teacher_note policies read a table inline - the 42P17 trap', v_count;
  end if;
  raise notice 'OK: no teacher_note policy reads a table inline';

  -- The full set: two SELECT, one INSERT, one UPDATE, one DELETE. This is the
  -- check that catches a policy that silently failed to create, which would leave
  -- a write open or a read shut without a word.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app'
    and tablename = 'teacher_note'
    and policyname in (
      'teacher_note_author_select', 'teacher_note_student_select',
      'teacher_note_author_insert', 'teacher_note_author_update',
      'teacher_note_author_delete'
    );

  if v_count <> 5 then
    raise exception 'FAIL: expected 5 teacher_note policies, found %', v_count;
  end if;
  raise notice 'OK: all five teacher_note policies present';

  -- authenticated must hold all four privileges, or a policy that allows an action
  -- is answered with `permission denied` before it is ever consulted.
  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'app'
    and table_name = 'teacher_note'
    and grantee = 'authenticated'
    and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');

  if v_count <> 4 then
    raise exception 'FAIL: authenticated should hold SELECT/INSERT/UPDATE/DELETE, holds % of 4', v_count;
  end if;
  raise notice 'OK: authenticated holds all four privileges';

  -- 0053 and 0055 policies must be untouched - this migration adds, it does not
  -- edit. If the count is short, something here reached a table it had no business
  -- touching.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app'
    and policyname in (
      'student_self_select', 'attendance_record_self_select',
      'class_session_attended_select', 'cohort_attended_select',
      'class_session_teacher_attended_select', 'teacher_taught_select',
      'teacher_self_select', 'class_session_teacher_own_select',
      'class_session_taught_select', 'cohort_taught_select',
      'attendance_record_taught_select', 'student_taught_select'
    );

  if v_count <> 12 then
    raise exception 'FAIL: expected 0053+0055''s 12 read policies intact, found %', v_count;
  end if;
  raise notice 'OK: 0053 and 0055 read policies all still present';
end $$;
