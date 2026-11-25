-- =============================================================================
-- 0071  jotform_submission, lesson_signoff_report, lesson_signoff reminders
-- =============================================================================
--
-- Task 038, phase 2: notice when a lesson's form comes back signed, and remind
-- until it does.
--
-- jotform_submission holds EVERY submission of the master form, matched or not.
-- A submission that names no known lesson, or whose visible fields do not match
-- what was sent, has no lesson_signoff row to sit on - and it is exactly the one
-- the admin has to see. Phase 3 (the Drive PDF) also needs the submission id.
--
-- NO SIGNATURE URL IS STORED. Jotform answers a signature with a link to the
-- image on its own host, and a host never belongs in a stored record (CLAUDE.md).
-- `has_signature` keeps the only fact matching needs; phase 3 reads the image
-- from Jotform by submission id when it builds the PDF.
--
-- `lesson_id_received` is TEXT, not uuid. It is whatever arrived in the hidden
-- lessonId field - a test submission, or an edited link, can send anything, and a
-- uuid column would reject the row before it could be recorded as unknown-lesson.
--
-- signed_at on lesson_signoff is WHEN THIS SYNC SAW the submission, accurate to
-- the hour. Jotform's own created_at carries NO offset - measured 25 Nov 2026 it
-- was US Eastern although the account is set to Asia/Kolkata - so it is kept
-- verbatim as jotform_created_at and
-- never parsed as an instant.
--
-- lesson_signoff_report records that the month-end unsigned list went out, one
-- row per business and month, so the hourly run sends it once.
--
-- Safe to re-run.
-- =============================================================================

alter table public.lesson_signoff
  add column if not exists reminder_count        smallint    not null default 0,
  add column if not exists last_reminded_at      timestamptz,
  add column if not exists jotform_submission_id text;

comment on column public.lesson_signoff.reminder_count is
  'How many reminder steps are behind this lesson (+3 days, +7 days, 3 days before '
  'month end). Steps that fell due together are counted at once and sent as one '
  'reminder, so a stopped sync never catches up with a burst of emails.';
comment on column public.lesson_signoff.jotform_submission_id is
  'The Jotform submission that signed this lesson. Set together with status signed.';

create unique index if not exists lesson_signoff_jotform_submission_id_key
  on public.lesson_signoff (jotform_submission_id)
  where jotform_submission_id is not null;

create table if not exists public.jotform_submission (
  submission_id       text        primary key,
  k_business          text        not null,
  form_id             text        not null,
  jotform_created_at  text,
  lesson_id_received  text,
  answers             jsonb       not null default '{}'::jsonb,
  has_signature       boolean     not null,
  outcome             text
                                  constraint jotform_submission_outcome_check
                                  check (outcome in ('signed', 'mismatch', 'unknown-lesson',
                                                     'no-signature', 'duplicate')),
  detail              text,
  lesson_signoff_id   uuid        references public.lesson_signoff (id) on delete set null,
  first_seen_at       timestamptz not null default now(),
  checked_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.jotform_submission is
  'Every submission of the lesson sign-off form, as read from the Jotform API. '
  'outcome null = not checked yet. Only signed links a lesson_signoff row; the '
  'others are reported to the admin. No signature URL is stored - see 0071.';
comment on column public.jotform_submission.answers is
  'The visible text fields as submitted, by unique name (student, date, '
  'teacherName, courseCode, fi). The signature is reduced to has_signature.';

create index if not exists jotform_submission_unchecked_idx
  on public.jotform_submission (first_seen_at)
  where outcome is null;
create index if not exists jotform_submission_lesson_idx
  on public.jotform_submission (lesson_id_received);

create table if not exists public.lesson_signoff_report (
  k_business      text        not null,
  month           date        not null,
  sent_at         timestamptz not null,
  unsigned_count  integer     not null,
  skipped_count   integer     not null,
  created_at      timestamptz not null default now(),
  primary key (k_business, month)
);

comment on table public.lesson_signoff_report is
  'The month-end list of unsigned lessons, sent once per month the day before '
  'month end (studio time). month is the first day of the month reported.';

drop trigger if exists jotform_submission_set_updated_at on public.jotform_submission;
create trigger jotform_submission_set_updated_at
  before update on public.jotform_submission
  for each row execute function public.set_updated_at();

-- Staff data: RLS on and no policy, so only the service role reads or writes.
alter table public.jotform_submission    enable row level security;
alter table public.lesson_signoff_report enable row level security;

-- Spelled out per table, as in 0070: tests/app-schema.test.ts forbids building
-- schema-qualified names dynamically after 0047.
do $$
declare n int;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.jotform_submission'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.lesson_signoff_report'::regclass) then
    raise exception '0071: RLS is not enabled on every new table';
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('jotform_submission', 'lesson_signoff_report');
  if n <> 0 then
    raise exception '0071: the new tables have % polic(ies); they must have none', n;
  end if;
end
$$;
