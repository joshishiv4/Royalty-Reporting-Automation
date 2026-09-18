-- =============================================================================
-- 0046  creation - what a student uploaded, and who it belongs to
--
-- WHY A TABLE AND NOT JUST THE BUCKET
--   The portal listed files by asking Supabase Storage for the bucket contents.
--   That works exactly as long as there is one student. Storage has no
--   `student_id`: it cannot answer "whose file is this", so EVERY student would
--   see EVERY student's work, and nothing in the listing could tell them apart.
--
--   It also loses things the moment the upload finishes:
--     * the original filename. The object is named with a uuid so that a caller
--       cannot overwrite somebody else's work, which means the bucket holds
--       `3efb220b-91ae-....jpg` and nothing that says "my-first-vlog.mp4". The
--       real name was returned once by the sign call and then gone.
--     * which project or session it belongs to
--     * anything a student might title or describe it with later
--
-- THE STORAGE PATH IS NOT A WELLNESSLIVING FIELD, so the rule the other owned
-- tables follow does not bite here: this is OUR bucket, named by our own code.
-- What must never appear is a signed URL - those expire, and a stored one is a
-- dead link by tomorrow. The URL is minted at read time, every time.
--
-- uploaded_at IS NULLABLE, AND THAT IS THE DESIGN
--   The browser uploads straight to storage, so there are two moments: when we
--   sign, and when the file actually lands. The row is written at the FIRST, and
--   `uploaded_at` is filled at the second.
--
--   A row whose upload was abandoned therefore sits here with `uploaded_at`
--   null. That is deliberate: it is COUNTABLE. The alternative - only writing
--   the row once the upload is confirmed - loses the abandoned attempt entirely
--   and leaves an orphan object in the bucket that nothing knows about. A
--   failure you can count is better than one you cannot see, which is the same
--   reasoning `sync_conflict` and the dead-letter queue are built on.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists public.creation (
  id                uuid        primary key default gen_random_uuid(),

  student_id        uuid        not null
                    references public.student (id) on delete cascade,

  -- Where the object lives in our bucket. The uuid name, not a URL.
  storage_path      text        not null,
  -- Supabase's own id for the object, when it is known. Nullable because it is
  -- only knowable after the upload lands, and the row is written before that.
  storage_object_id uuid,

  -- What the student called it. This is the ONLY place it survives.
  original_filename text,

  -- Declared by the browser at upload. Not enforced by anything here - this API
  -- never sees the bytes - so it is a label, not a guarantee. Kept because it is
  -- what drives the icon, and asking storage for it again is a round trip per
  -- file.
  content_type      text,
  size_bytes        bigint,

  -- NULL until the upload is confirmed. See the header: an abandoned upload is
  -- meant to be visible.
  uploaded_at       timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint creation_storage_path_unique unique (storage_path)
);

comment on table public.creation is
  'A file a student uploaded. Exists because Storage cannot say whose file is '
  'whose, and loses the original filename the moment the upload finishes. Holds '
  'the storage PATH, never a signed URL - those expire, and a stored one is a '
  'dead link tomorrow.';
comment on column public.creation.uploaded_at is
  'NULL until the browser confirms the upload landed. A row that stays null is '
  'an abandoned attempt, and is meant to be countable rather than invisible.';
comment on column public.creation.content_type is
  'What the BROWSER declared. This API never sees the bytes, so it is a label '
  'rather than a guarantee; the bucket is the only thing that enforces type.';

create index if not exists creation_student_idx
  on public.creation (student_id, created_at desc);

-- Finding the abandoned ones, which is the whole point of the nullable column.
create index if not exists creation_pending_idx
  on public.creation (created_at) where uploaded_at is null;

drop trigger if exists creation_set_updated_at on public.creation;
create trigger creation_set_updated_at
  before update on public.creation
  for each row execute function public.set_updated_at();

-- On with no policies: nothing readable except through the service role, which
-- is what the portal's route uses today. Per-student policies arrive with
-- sign-in, and writing one now would be writing it against a guess.
alter table public.creation enable row level security;
