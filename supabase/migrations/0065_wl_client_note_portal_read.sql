-- =============================================================================
-- 0065  wl_client_note in the portal: a seen date, and two ways to read it
--
-- Decided 19 Oct 2026 (the studio, in conversation): the WellnessLiving profile
-- note 0064 syncs is shown in the portal's notes tabs -
--
--   * a TEACHER sees the note of every student they teach, tagged with that
--     student's name, read-only, beside their own public notes;
--   * a STUDENT sees their OWN note, and nobody else's.
--
-- This REVERSES part of 0064's reasoning, knowingly. 0064 kept the note off
-- `person` because a client reads their own person row and the notes were
-- assumed to be staff-only. The studio has now decided a client may read their
-- own note. Every note already written - 260 of them, some plainly written for
-- staff (rate negotiations, a third party's phone number) - becomes visible to
-- the student it is about once the portal ships. That was said before the
-- decision was made.
--
-- -----------------------------------------------------------------------------
-- STILL NO POLICY ON THE TABLE - TWO DEFINER FUNCTIONS INSTEAD
-- -----------------------------------------------------------------------------
-- The obvious build is two SELECT policies on wl_client_note. Not done, for
-- three reasons:
--
--   1. The note is keyed by WL `uid`; the portal's people are `app.student`.
--      The join runs through `app.identity`, and 0055 learned the hard way
--      (42P17, infinite recursion) that a policy reading another policied table
--      is a trap. The established answer is a SECURITY DEFINER helper.
--   2. A function returns exactly the columns a reader may have: note_text and
--      the seen date. note_html, raw_wl_id and k_business never leave. A policy
--      grants the row, every column of it.
--   3. 0064's trailing check - "no policy on wl_client_note" - stays true, so
--      the table is still closed to anything that is not one of these two
--      functions or the service role. There are exactly two doors, both here.
--
-- Each function decides "who am I" from the JWT alone (current_teacher_id /
-- current_student_id), takes no argument, and so has no id to tamper with.
--
-- -----------------------------------------------------------------------------
-- note_seen_at - WHAT "NEWEST FIRST" CAN HONESTLY MEAN
-- -----------------------------------------------------------------------------
-- WL returns no author and no date for a note (STATUS, blocked 5). The portal
-- still orders notes newest first, so a WL note needs a time. The only honest
-- one is when THIS SYSTEM first saw the note, or saw it change:
--
--   * set on insert;
--   * reset when note_html changes - an edited note is new information;
--   * left alone otherwise, so the nightly re-sync of an unchanged note does not
--     float it to the top every morning. (updated_at cannot serve: the daily
--     upsert moves synced_at, which fires the updated_at trigger.)
--
-- For notes written from now on, that is within a day of the real date. For the
-- 260 already written, it is the date of the first sync - they all share it.
-- The portal labels it "seen", never "written".
--
-- Requires 0055 (current_teacher_id, teaches_student), 0053
-- (current_student_id) and 0064. Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. note_seen_at
-- -----------------------------------------------------------------------------
alter table public.wl_client_note
  add column if not exists note_seen_at timestamptz;

-- Rows synced before this migration: the best available answer is when the row
-- appeared, which is when the sync first saw the note.
update public.wl_client_note
   set note_seen_at = created_at
 where note_seen_at is null;

alter table public.wl_client_note
  alter column note_seen_at set default now(),
  alter column note_seen_at set not null;

comment on column public.wl_client_note.note_seen_at is
  'When this system first saw the note, or last saw its HTML change. NOT when it '
  'was written: WL does not say. Notes that existed before the first sync all '
  'carry that sync''s time. Maintained by trigger; the sync never sends it.';

create or replace function public.wl_client_note_seen()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.note_seen_at := now();
  elsif new.note_html is distinct from old.note_html then
    new.note_seen_at := now();
  else
    -- Unchanged note: keep the date, whatever the writer sent.
    new.note_seen_at := old.note_seen_at;
  end if;
  return new;
end
$$;

drop trigger if exists wl_client_note_seen on public.wl_client_note;
create trigger wl_client_note_seen
  before insert or update on public.wl_client_note
  for each row execute function public.wl_client_note_seen();

create index if not exists wl_client_note_seen_idx
  on public.wl_client_note (note_seen_at desc);


-- -----------------------------------------------------------------------------
-- 2. The teacher's door: notes of the students I teach
-- -----------------------------------------------------------------------------
-- A note with no text (WL's "Note with no text") is left out: there is nothing
-- to show, and an empty card reads as a bug.
create or replace function app.my_students_wl_notes()
returns table (
  student_id   uuid,
  student_name text,
  note_text    text,
  note_seen_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.student_id,
         nullif(trim(concat_ws(' ', s.first_name, s.last_name)), ''),
         n.note_text,
         n.note_seen_at
  from public.wl_client_note n
  join app.identity i on i.uid = n.uid
  join app.student  s on s.id  = i.student_id
  where app.current_teacher_id() is not null
    and app.teaches_student(i.student_id)
    and n.note_text is not null
  order by n.note_seen_at desc
$$;

comment on function app.my_students_wl_notes() is
  'The WellnessLiving profile notes of the students the signed-in teacher teaches '
  '(app.teaches_student), plain text only. Empty for a student, an unlinked human '
  'or anon. One of the two ways into wl_client_note, which has no policy (0064).';

revoke execute on function app.my_students_wl_notes() from public, anon;
grant  execute on function app.my_students_wl_notes() to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. The student's door: my own note
-- -----------------------------------------------------------------------------
create or replace function app.my_wl_note()
returns table (
  note_text    text,
  note_seen_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.note_text,
         n.note_seen_at
  from public.wl_client_note n
  join app.identity i on i.uid = n.uid
  where i.student_id = app.current_student_id()
    and n.note_text is not null
$$;

comment on function app.my_wl_note() is
  'The signed-in student''s own WellnessLiving profile note, plain text only - '
  'never anyone else''s. `= current_student_id()` is NULL, so no rows, for a '
  'teacher, an unlinked human or anon. Decided 19 Oct 2026 (0065 header).';

revoke execute on function app.my_wl_note() from public, anon;
grant  execute on function app.my_wl_note() to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- Trailing checks
-- -----------------------------------------------------------------------------
do $$
declare n int;
begin
  -- The table is still closed: the two functions are the only way in.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'wl_client_note';
  if n <> 0 then
    raise exception '0065: public.wl_client_note has % polic(ies); access goes through '
                    'app.my_students_wl_notes() and app.my_wl_note() only', n;
  end if;

  -- Both doors run as definer with an empty search_path, and anon cannot call them.
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app'
     and p.proname in ('my_students_wl_notes', 'my_wl_note')
     and p.prosecdef
     and p.proconfig @> array['search_path=""'];
  if n <> 2 then
    raise exception '0065: expected both note functions SECURITY DEFINER with search_path '''', found %', n;
  end if;

  if has_function_privilege('anon', 'app.my_wl_note()', 'execute')
     or has_function_privilege('anon', 'app.my_students_wl_notes()', 'execute') then
    raise exception '0065: anon can execute a note function';
  end if;

  -- note_html never leaves through either function.
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'app'
                and p.proname in ('my_students_wl_notes', 'my_wl_note')
                and 'note_html' = any (coalesce(p.proargnames, '{}'))) then
    raise exception '0065: a note function returns note_html';
  end if;
end
$$;
