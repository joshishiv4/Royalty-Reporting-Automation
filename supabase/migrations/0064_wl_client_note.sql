-- =============================================================================
-- 0064  wl_client_note: the note studio staff write on a WellnessLiving profile
--
-- The NOTES panel on a client's WL profile ("$15 VIP Discount Monthly", added by
-- a staff member) is the studio's own memo about that client - discounts, family
-- arrangements, call-back details, sometimes a whole pasted email. This stores it,
-- and keeps it current on every client-list pass.
--
-- -----------------------------------------------------------------------------
-- WHERE IT COMES FROM - AND WHERE IT DOES NOT
-- -----------------------------------------------------------------------------
-- Measured live 19 Oct 2026, on a client whose profile shows one note:
--
--   /v1/report/data   carries an `s_note` field on every row. It was "" on all
--                     256 rows - including the client with the note. It is not
--                     the profile note.
--   /v1/report/query  (the Client List report the sync already reads, cid 689)
--                     carries two columns, `o_note.has_note` (boolean) and
--                     `o_note.text_note_list` (string). 260 of 524 activated
--                     clients have a note.
--
-- So this costs NO extra API call: the note arrives in the same page that writes
-- `person`, and every such page is already kept verbatim in raw_wl.
--
-- -----------------------------------------------------------------------------
-- WHY A TABLE AND NOT A COLUMN ON person
-- -----------------------------------------------------------------------------
-- person is readable by the client it describes: `person_self_select` (0053)
-- lets a signed-in student select their own row, every column of it. A note
-- column there would hand each student the studio's notes about them - and the
-- notes include things like "THEY'LL LET US KNOW. INFORMED OUR RATES ARE CURRENT
-- AND FIRM". That is the same reason ghl_contact.tags lives off person (0026):
-- the studio's notes about a client are not the client's to read.
--
-- It is also NOT app.teacher_note (0056). That table is written by teachers in
-- the portal, and a public note there is addressed to a student who can read
-- it. Mixing WL's staff-only memo into it would put it one visibility flag away
-- from a student.
--
-- -----------------------------------------------------------------------------
-- HTML, VERBATIM - AND A PLAIN-TEXT COPY BESIDE IT
-- -----------------------------------------------------------------------------
-- WL sends the note as a whole HTML document, not text:
--
--   "<!DOCTYPE html>\n<html>\n<head>\n</head>\n<body>\n<p>$15 VIP Discount
--    Monthly</p>\n</body>\n</html>"
--
-- and 81 of the 260 are rich: lists, <br />, &nbsp;, Gmail <div>s from a pasted
-- email. note_html keeps exactly what WL sent, so nothing is lost to our own
-- parser; note_text is that HTML reduced to readable lines by the sync, which is
-- what a report or a search actually wants. If the reduction is ever wrong, it is
-- recomputable from note_html (or raw_wl) with no API call.
--
-- -----------------------------------------------------------------------------
-- has_note DECIDES, AND IT IS ALLOWED TO DELETE
-- -----------------------------------------------------------------------------
-- Everywhere else the client sync merges and never clobbers: WL's "" is the
-- absence of evidence, not evidence of deletion. A note is the exception, because
-- WL states the fact outright: `has_note: false` says there is no note. When a
-- staff member removes a note in WL, the next pass deletes the row here. Without
-- that, a removed discount note would sit in this table forever.
--
-- Anything other than an explicit true or false leaves the row alone - that IS
-- the absence of evidence.
--
-- -----------------------------------------------------------------------------
-- WHAT IS NOT HERE, AND WHY IT IS NOT GUESSED
-- -----------------------------------------------------------------------------
-- The portal shows "Added by <staff member> on <date>". Neither report carries
-- either: no author column, no date column, and the 38 columns of cid 689 were
-- read in full to check. No other documented endpoint returns notes. So there
-- is no author and no created date in this table - not a nullable one waiting
-- to be filled, because nothing could fill it. If WL names an endpoint that
-- does, that is a new migration. (STATUS.md, blocked.)
--
-- Several notes on one profile arrive as ONE string in text_note_list; how WL
-- joins them is not yet observed, so this is one row per client.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists public.wl_client_note (
  -- The 0035 convention: a uuid id as the primary key (plumbing), and the
  -- natural key kept UNIQUE as <table>_natkey_unique - which is what the sync's
  -- upsert names, so a re-sync never duplicates.
  id          uuid        primary key default gen_random_uuid(),

  -- One row per client: WL's own uid, as text. The FK holds because the sync
  -- writes person before the note, from the same page; cascade because a note
  -- about nobody is meaningless.
  uid         text        not null
                          constraint wl_client_note_natkey_unique unique
                          references public.person (uid) on delete cascade,

  k_business  text        not null,

  -- Exactly what WL sent in o_note.text_note_list. Null only when WL says a note
  -- exists but sends no text - its own message catalogue carries
  -- "Note with no text", so the case is real enough to allow for.
  note_html   text,

  -- note_html reduced to plain lines by the sync (src/sync/clients.ts,
  -- noteText). Derived, so recomputable; never edited by hand.
  note_text   text,

  -- Which stored client-list page this was read from. No FK, for the same
  -- reason raw_link has none: a missing lookup must not fail the row.
  raw_wl_id   uuid,

  -- Last confirmed against WellnessLiving - the same meaning synced_at has on
  -- person, so stale_after() reads the same way here.
  synced_at   timestamptz not null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.wl_client_note is
  'The note studio staff write on a WellnessLiving client profile, one row per '
  'client, from the Client List report (o_note.*). Staff-only: RLS on and no '
  'policy, because person is readable by its own client and these notes are '
  'the studio''s, not the client''s. Deleted when WL reports has_note = false. '
  'No author and no date: WL returns neither.';

comment on column public.wl_client_note.note_html is
  'o_note.text_note_list verbatim - WL sends a whole HTML document. Null when '
  'WL says a note exists but sends no text.';

comment on column public.wl_client_note.note_text is
  'note_html reduced to plain lines by the sync. Derived and recomputable from '
  'note_html; read this one for reports and search.';

create index if not exists wl_client_note_business_idx
  on public.wl_client_note (k_business);


-- -----------------------------------------------------------------------------
-- updated_at trigger and RLS, matching 0006, 0010 and 0026
-- -----------------------------------------------------------------------------
-- set_updated_at() is created by 0005 and again by 0006. Repeated here so this
-- file runs standalone in a SQL editor, which is how these get applied.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists wl_client_note_set_updated_at on public.wl_client_note;
create trigger wl_client_note_set_updated_at
  before update on public.wl_client_note
  for each row execute function public.set_updated_at();

-- RLS ON, AND DELIBERATELY NO POLICY - no authenticated or anon user reaches a
-- row. Reporting and the sync run on the service role, which bypasses RLS. This
-- is the whole point of the table being separate from person; a policy added
-- here later must not be "a client reads their own note".
alter table public.wl_client_note enable row level security;


-- -----------------------------------------------------------------------------
-- Trailing checks - the guarantee, asserted where it is made
-- -----------------------------------------------------------------------------
do $$
declare n int;
begin
  if not (select relrowsecurity from pg_class
          where oid = 'public.wl_client_note'::regclass) then
    raise exception '0064: RLS is not enabled on public.wl_client_note';
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'wl_client_note';
  if n <> 0 then
    raise exception '0064: public.wl_client_note has % polic(ies); it must have none - '
                    'these are staff notes, and person_self_select already lets a client '
                    'read their own person row', n;
  end if;
end
$$;
