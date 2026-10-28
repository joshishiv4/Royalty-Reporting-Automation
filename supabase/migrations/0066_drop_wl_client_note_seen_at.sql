-- =============================================================================
-- 0066  wl_client_note: drop note_seen_at
--
-- Decided 28 Oct 2026: the portal shows a WellnessLiving profile note WITHOUT a
-- date. note_seen_at (0065) was never the date a note was written - WL returns
-- no author and no date (STATUS, blocked 5) - only when this system first saw
-- the note or saw its HTML change. For the 260 notes that existed before the
-- first sync it was the same day for all of them. A date that reads like "when
-- the studio wrote this" and is not, is worse than no date, so it goes.
--
-- What goes with it:
--   * the trigger wl_client_note_seen and its function, which kept the column;
--   * the index wl_client_note_seen_idx, which sorted by it;
--   * note_seen_at in the result of both portal functions. Their return type
--     changes, which `create or replace` cannot do, so each is dropped and
--     recreated - same body otherwise, same definer + empty search_path, same
--     grants, still never note_html.
--
-- app.my_students_wl_notes() was ordered newest first by note_seen_at. With no
-- date there is no honest "newest", so it orders by student name instead.
--
-- RE-RUNNING 0065 UNDOES THIS: it re-adds the column, the trigger and the date
-- in both functions. Re-run 0066 after it.
--
-- Requires 0065. Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The column and everything that kept it
-- -----------------------------------------------------------------------------
drop trigger if exists wl_client_note_seen on public.wl_client_note;
drop function if exists public.wl_client_note_seen();
drop index if exists public.wl_client_note_seen_idx;


-- -----------------------------------------------------------------------------
-- 2. The teacher's door, without the date
-- -----------------------------------------------------------------------------
-- Dropped before the column: the old body names note_seen_at.
drop function if exists app.my_students_wl_notes();

create function app.my_students_wl_notes()
returns table (
  student_id   uuid,
  student_name text,
  note_text    text
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.student_id,
         nullif(trim(concat_ws(' ', s.first_name, s.last_name)), ''),
         n.note_text
  from public.wl_client_note n
  join app.identity i on i.uid = n.uid
  join app.student  s on s.id  = i.student_id
  where app.current_teacher_id() is not null
    and app.teaches_student(i.student_id)
    and n.note_text is not null
  order by s.first_name, s.last_name, i.student_id
$$;

comment on function app.my_students_wl_notes() is
  'The WellnessLiving profile notes of the students the signed-in teacher teaches '
  '(app.teaches_student), plain text only, no date (WL gives none - 0066). Empty '
  'for a student, an unlinked human or anon. One of the two ways into '
  'wl_client_note, which has no policy (0064).';

revoke execute on function app.my_students_wl_notes() from public, anon;
grant  execute on function app.my_students_wl_notes() to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. The student's door, without the date
-- -----------------------------------------------------------------------------
drop function if exists app.my_wl_note();

create function app.my_wl_note()
returns table (
  note_text text
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.note_text
  from public.wl_client_note n
  join app.identity i on i.uid = n.uid
  where i.student_id = app.current_student_id()
    and n.note_text is not null
$$;

comment on function app.my_wl_note() is
  'The signed-in student''s own WellnessLiving profile note, plain text only, no '
  'date (WL gives none - 0066) - never anyone else''s. `= current_student_id()` '
  'is NULL, so no rows, for a teacher, an unlinked human or anon.';

revoke execute on function app.my_wl_note() from public, anon;
grant  execute on function app.my_wl_note() to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 4. Now nothing reads it, the column itself
-- -----------------------------------------------------------------------------
alter table public.wl_client_note
  drop column if exists note_seen_at;


-- -----------------------------------------------------------------------------
-- Trailing checks
-- -----------------------------------------------------------------------------
do $$
declare n int;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'wl_client_note'
                and column_name = 'note_seen_at') then
    raise exception '0066: wl_client_note.note_seen_at still exists';
  end if;

  if exists (select 1 from pg_trigger
              where tgrelid = 'public.wl_client_note'::regclass
                and tgname = 'wl_client_note_seen') then
    raise exception '0066: trigger wl_client_note_seen still exists';
  end if;

  -- 0064 and 0065's guarantees still hold.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'wl_client_note';
  if n <> 0 then
    raise exception '0066: public.wl_client_note has % polic(ies); access goes through '
                    'app.my_students_wl_notes() and app.my_wl_note() only', n;
  end if;

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app'
     and p.proname in ('my_students_wl_notes', 'my_wl_note')
     and p.prosecdef
     and p.proconfig @> array['search_path=""'];
  if n <> 2 then
    raise exception '0066: expected both note functions SECURITY DEFINER with search_path '''', found %', n;
  end if;

  if has_function_privilege('anon', 'app.my_wl_note()', 'execute')
     or has_function_privilege('anon', 'app.my_students_wl_notes()', 'execute') then
    raise exception '0066: anon can execute a note function';
  end if;

  if not has_function_privilege('authenticated', 'app.my_wl_note()', 'execute')
     or not has_function_privilege('authenticated', 'app.my_students_wl_notes()', 'execute') then
    raise exception '0066: authenticated lost execute on a note function';
  end if;

  -- Neither function returns note_html or a date.
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'app'
                and p.proname in ('my_students_wl_notes', 'my_wl_note')
                and (    'note_html'    = any (coalesce(p.proargnames, '{}'))
                      or 'note_seen_at' = any (coalesce(p.proargnames, '{}')))) then
    raise exception '0066: a note function returns note_html or note_seen_at';
  end if;
end
$$;
