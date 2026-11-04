-- =============================================================================
-- 0068  wl_client_note: one row per WellnessLiving note, not one per client
--
-- Decided 28 Oct 2026 (the studio, in conversation). WL sends ALL of a client's
-- profile notes as ONE string in o_note.text_note_list, joined with ", ". 0064
-- assumed one note per profile ("how WL joins them has not been observed"); it
-- has now been observed. Measured on dev, 28 Oct 2026:
--
--   * 164 of 339 stored rows hold more than one note - 676 notes in all;
--   * every HTML note is a whole document, so a note ends at `</html>` and the
--     next starts after the ", " that follows it - an unambiguous boundary;
--   * 75 rows end in older plain-text notes, always AFTER the HTML ones (0 rows
--     the other way round);
--   * 29 of those plain-text tails contain ", " themselves. Whether that is two
--     notes or one note with a comma is not decidable from the string, so a
--     plain-text tail stays ONE note. Splitting it on a guess would invent notes.
--
-- The portal showed a client's two notes as one card. From here each note is its
-- own wl_client_note row, and so its own teacher_note (0067).
--
-- -----------------------------------------------------------------------------
-- WHICH ROW IS WHICH NOTE: A HASH, NOT A POSITION
-- -----------------------------------------------------------------------------
-- note_key = the first 32 hex of sha256 over the note's HTML exactly as WL sent it
-- (plus "#n" for a repeat of the same text on one profile), computed by the sync.
-- A position (0, 1, 2) was considered and rejected: WL lists the newest note
-- first, so one new note would shift every other note's position and every note
-- would look edited. A hash keeps a note's identity while notes are added around
-- it. An edit in WL is a new key: the old note is removed (its teacher_note
-- soft-deleted) and the edited one arrives as new - which is what WL shows.
--
-- `position` is kept for display only: 0 is the note WL lists first.
--
-- -----------------------------------------------------------------------------
-- EXISTING ROWS ARE NOT SPLIT HERE
-- -----------------------------------------------------------------------------
-- Splitting needs the sync's own text reduction (noteText in src/sync/clients.ts)
-- for note_text; a second copy in SQL would drift. So each existing row keeps
-- its combined text, takes the key the sync would give it as a single note, and
-- the NEXT client-list pass replaces the 164 combined rows with their parts. A
-- row that was already a single note keeps the same key, so it does not churn.
--
-- The sync writes a page through public.replace_wl_client_notes(): every client
-- WL spoke for has its notes replaced by exactly the set on the page, in one
-- call, instead of a delete per client.
--
-- teacher_note_link becomes (uid, note_key) and carries `position` - the one
-- thing besides provenance WL gives about a note, and the order the portal needs
-- to show a client's notes in WL's order. readable alongside the note id only.
--
-- RE-RUNNING 0067 RECREATES the single-key sync function and drops this file's;
-- re-run 0068 after it. Requires 0064, 0067. Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. wl_client_note: key and position
-- -----------------------------------------------------------------------------
alter table public.wl_client_note
  add column if not exists note_key text,
  add column if not exists position integer;

-- The key the sync would compute for this text as a single note.
update public.wl_client_note
   set note_key = coalesce(note_key,
         case when note_html is null then 'empty'
              else substr(encode(sha256(convert_to(note_html, 'UTF8')), 'hex'), 1, 32) end),
       position = coalesce(position, 0)
 where note_key is null or position is null;

alter table public.wl_client_note
  alter column note_key set not null,
  alter column position set not null,
  alter column position set default 0;

alter table public.wl_client_note drop constraint if exists wl_client_note_natkey_unique;
alter table public.wl_client_note drop constraint if exists wl_client_note_note_unique;
alter table public.wl_client_note
  add constraint wl_client_note_note_unique unique (uid, note_key);

create index if not exists wl_client_note_uid_idx on public.wl_client_note (uid);

comment on column public.wl_client_note.note_key is
  'Which of a client''s notes this is: first 32 hex of sha256 over the note''s '
  'HTML as WL sent it, "#n" for a repeat. A hash, not a position, so a new note '
  'does not shift the others - see 0068.';
comment on column public.wl_client_note.position is
  'Display order only: 0 is the note WL lists first (its newest).';


-- -----------------------------------------------------------------------------
-- 2. teacher_note_link: one link per WL note
-- -----------------------------------------------------------------------------
alter table app.teacher_note_link
  add column if not exists note_key text,
  add column if not exists position integer;

-- Until now a uid had one wl row and one link; carry that row's key and position.
update app.teacher_note_link l
   set note_key = w.note_key,
       position = w.position
  from public.wl_client_note w
 where w.uid = l.uid
   and l.note_key is null;

-- A link whose wl row is already gone keeps a key that can never match again;
-- its note was soft-deleted when the row went.
update app.teacher_note_link
   set note_key = 'gone:' || teacher_note_id, position = 0
 where note_key is null;

alter table app.teacher_note_link
  alter column note_key set not null,
  alter column position set not null,
  alter column position set default 0;

alter table app.teacher_note_link drop constraint if exists teacher_note_link_uid_unique;
alter table app.teacher_note_link drop constraint if exists teacher_note_link_note_unique;
alter table app.teacher_note_link
  add constraint teacher_note_link_note_unique unique (uid, note_key);

grant select (teacher_note_id, position) on app.teacher_note_link to authenticated;

comment on table app.teacher_note_link is
  'Provenance of a teacher_note copied from one WellnessLiving profile note '
  '(public.wl_client_note), keyed by WL uid + note_key. A note with a link came '
  'from WL and is read-only. position is WL''s display order - 0067, 0068.';


-- -----------------------------------------------------------------------------
-- 3. The per-note sync function (replaces 0067's per-client one)
-- -----------------------------------------------------------------------------
drop trigger if exists wl_client_note_to_teacher_note on public.wl_client_note;
drop function if exists public.sync_wl_note_to_teacher_note(text);

create or replace function public.sync_wl_note_to_teacher_note(p_uid text, p_note_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text       text;
  v_position   integer;
  v_note       uuid;
  v_student    uuid;
  v_teacher    uuid;
  v_identities int;
begin
  select nullif(btrim(n.note_text), ''), n.position into v_text, v_position
    from public.wl_client_note n where n.uid = p_uid and n.note_key = p_note_key;

  select l.teacher_note_id into v_note
    from app.teacher_note_link l where l.uid = p_uid and l.note_key = p_note_key;

  -- Gone from WL (row deleted) or empty: soft-delete, never destroy (0058).
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
    update app.teacher_note_link set position = v_position
     where teacher_note_id = v_note and position is distinct from v_position;
    return;
  end if;

  -- First sighting: exactly one identity, or nothing (0054's rule).
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

  insert into app.teacher_note_link (teacher_note_id, uid, note_key, position)
  values (v_note, p_uid, p_note_key, v_position);
end
$$;

comment on function public.sync_wl_note_to_teacher_note(text, text) is
  'Makes app.teacher_note agree with one WellnessLiving note (uid + note_key): a '
  'student''s -> public note to them, no author; a teacher''s -> their own '
  'private note; gone or empty -> soft-deleted. Idempotent - 0067, 0068.';

revoke execute on function public.sync_wl_note_to_teacher_note(text, text) from public, anon, authenticated;

create or replace function public.wl_client_note_to_teacher_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A key never changes in place (it IS the text), but an UPDATE that somehow
  -- did change it must settle the old note as well as the new one.
  if tg_op = 'UPDATE' and old.note_key is distinct from new.note_key then
    perform public.sync_wl_note_to_teacher_note(old.uid, old.note_key);
  end if;
  perform public.sync_wl_note_to_teacher_note(coalesce(new.uid, old.uid),
                                              coalesce(new.note_key, old.note_key));
  return null;
end
$$;

create trigger wl_client_note_to_teacher_note
  after insert or update or delete on public.wl_client_note
  for each row execute function public.wl_client_note_to_teacher_note();


-- -----------------------------------------------------------------------------
-- 4. How the sync writes a page: replace each client's notes with WL's set
-- -----------------------------------------------------------------------------
-- p_uids:  every client the page speaks for (has_note true OR false).
-- p_notes: every note on the page, one object per note.
-- A client in p_uids keeps exactly the notes in p_notes; has_note false is a
-- client with no notes in p_notes, so all of theirs go.
create or replace function public.replace_wl_client_notes(p_uids text[], p_notes jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  delete from public.wl_client_note w
   where w.uid = any (p_uids)
     and not exists (
       select 1 from jsonb_to_recordset(p_notes) as x(uid text, note_key text)
        where x.uid = w.uid and x.note_key = w.note_key);

  insert into public.wl_client_note
         (uid, k_business, note_key, position, note_html, note_text, raw_wl_id, synced_at)
  select x.uid, x.k_business, x.note_key, x.position, x.note_html, x.note_text,
         x.raw_wl_id, x.synced_at
    from jsonb_to_recordset(p_notes) as x(
           uid text, k_business text, note_key text, position integer,
           note_html text, note_text text, raw_wl_id uuid, synced_at timestamptz)
  on conflict (uid, note_key) do update
     set k_business = excluded.k_business,
         position   = excluded.position,
         note_html  = excluded.note_html,
         note_text  = excluded.note_text,
         raw_wl_id  = excluded.raw_wl_id,
         synced_at  = excluded.synced_at;

  get diagnostics n = row_count;
  return n;
end
$$;

comment on function public.replace_wl_client_notes(text[], jsonb) is
  'One client-list page''s notes: each uid in p_uids keeps exactly its notes in '
  'p_notes (upserted on uid + note_key), the rest of its notes are deleted. The '
  'sync''s only way to write wl_client_note - 0068.';

revoke execute on function public.replace_wl_client_notes(text[], jsonb) from public, anon, authenticated;
grant  execute on function public.replace_wl_client_notes(text[], jsonb) to service_role;


-- -----------------------------------------------------------------------------
-- 5. Settle every existing note under the new keys (idempotent)
-- -----------------------------------------------------------------------------
select public.sync_wl_note_to_teacher_note(n.uid, n.note_key) from public.wl_client_note n;


-- -----------------------------------------------------------------------------
-- Trailing checks
-- -----------------------------------------------------------------------------
do $$
declare n int;
begin
  if exists (select 1 from pg_constraint where conname = 'wl_client_note_natkey_unique') then
    raise exception '0068: wl_client_note is still one row per client';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wl_client_note_note_unique') then
    raise exception '0068: wl_client_note (uid, note_key) unique missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teacher_note_link_note_unique')
     or exists (select 1 from pg_constraint where conname = 'teacher_note_link_uid_unique') then
    raise exception '0068: teacher_note_link is not keyed by (uid, note_key)';
  end if;

  -- Every WL note with text, of a uid with exactly one student/teacher identity,
  -- has exactly one live linked note.
  select count(*) into n
    from public.wl_client_note w
   where nullif(btrim(w.note_text), '') is not null
     and (select count(*) from app.identity i where i.uid = w.uid) = 1
     and exists (select 1 from app.identity i where i.uid = w.uid
                  and (i.student_id is not null or i.teacher_id is not null))
     and not exists (
       select 1 from app.teacher_note_link l
         join app.teacher_note t on t.id = l.teacher_note_id
        where l.uid = w.uid and l.note_key = w.note_key and t.deleted_at is null);
  if n <> 0 then
    raise exception '0068: % WL note(s) without a live linked teacher_note', n;
  end if;

  if has_column_privilege('authenticated', 'app.teacher_note_link', 'uid', 'select')
     or has_column_privilege('authenticated', 'app.teacher_note_link', 'note_key', 'select') then
    raise exception '0068: authenticated can read the link''s WL key';
  end if;
  if not has_column_privilege('authenticated', 'app.teacher_note_link', 'position', 'select') then
    raise exception '0068: authenticated cannot read the link''s position';
  end if;

  if has_function_privilege('authenticated', 'public.replace_wl_client_notes(text[], jsonb)', 'execute')
     or has_function_privilege('anon', 'public.replace_wl_client_notes(text[], jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.sync_wl_note_to_teacher_note(text, text)', 'execute') then
    raise exception '0068: a note function is callable through the API';
  end if;

  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'public' and p.proname = 'sync_wl_note_to_teacher_note'
                and p.pronargs = 1) then
    raise exception '0068: 0067''s single-key sync function still exists - re-run 0068';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.wl_client_note'::regclass
                    and tgname = 'wl_client_note_to_teacher_note') then
    raise exception '0068: wl_client_note trigger missing';
  end if;
end
$$;
