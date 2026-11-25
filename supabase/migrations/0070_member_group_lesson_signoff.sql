-- =============================================================================
-- 0070  member_group, member_group_member, lesson_signoff
-- =============================================================================
--
-- WHY THESE EXIST. The studio's Fiscal Intermediary (FI) for a self-direction
-- (SDC) student is not a profile field in WellnessLiving - it is a CLIENT GROUP
-- (ISS, AIM, EEDA, Self Pay, ...). Measured 19 Nov 2026: 28 groups; "SDC Clients"
-- holds 216 students, 186 of whom are in exactly one other group (their FI), 28
-- in none and 2 in two. `/v1/member/group/list?is_return_members=1` returns every
-- group with its member uids in one call; it is NOT in WL's v1 docs, but works.
--
-- lesson_signoff is the per-lesson "Student Lesson Confirmation Form" request the
-- admin used to build by hand in Jotform (task 038). One row per attended WL
-- visit, so a rerun of the sync can never create or email a lesson twice.
--
-- member_group_member.uid HAS NO FOREIGN KEY TO person, deliberately. Group
-- membership names clients the client list may not have stored yet (a member
-- uid absent from person was seen on 20 Nov 2026), and a stub row per member
-- would invent people to satisfy a constraint that protects nothing here: the
-- table is a mirror, refreshed whole on every member_group_sync.
--
-- NO URL IS STORED ON lesson_signoff. The prefilled Jotform link embeds the form
-- host, and a host never belongs in a stored record (CLAUDE.md). The link is
-- rebuilt from configuration whenever it is needed. The recipient address is
-- configuration too, so it is not stored either - only that and when it was sent.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists public.member_group (
  k_member_group  text        primary key,
  k_business      text        not null,
  title           text        not null,
  icon            text,
  synced_at       timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.member_group is
  'WellnessLiving client groups (/v1/member/group/list). For this studio a group '
  'is how a student''s Fiscal Intermediary is recorded; "SDC Clients" marks the '
  'self-direction students who need lesson sign-offs.';

create table if not exists public.member_group_member (
  k_member_group  text        not null
                              references public.member_group (k_member_group) on delete cascade,
  uid             text        not null,
  k_business      text        not null,
  synced_at       timestamptz not null,
  created_at      timestamptz not null default now(),
  primary key (k_member_group, uid)
);

comment on table public.member_group_member is
  'Who is in which WellnessLiving client group. Replaced on every member_group_sync: '
  'rows not seen in the latest read are deleted, because WL keeps current '
  'membership only. No FK to person - see 0070''s header.';

create index if not exists member_group_member_uid_idx
  on public.member_group_member (uid);

create table if not exists public.lesson_signoff (
  id                 uuid        primary key default gen_random_uuid(),
  k_business         text        not null,
  k_visit            text        not null
                                 constraint lesson_signoff_k_visit_unique unique,
  uid                text        not null,
  k_period           text        not null,
  dt_start_utc       timestamptz not null,
  dtl_start_local    timestamp   not null,
  class_title        text        not null,
  student_name       text,
  teacher_name       text,
  course_code        text        not null,
  fi_k_member_group  text,
  fi_title           text,
  status             text        not null default 'pending'
                                 constraint lesson_signoff_status_check
                                 check (status in ('pending', 'sent', 'skipped', 'signed')),
  skip_reason        text
                                 constraint lesson_signoff_skip_reason_check
                                 check (skip_reason in ('no-fi', 'multiple-fi', 'missing-detail')),
  sent_at            timestamptz,
  signed_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint lesson_signoff_skip_has_reason
    check ((status = 'skipped') = (skip_reason is not null))
);

comment on table public.lesson_signoff is
  'One per-lesson parent sign-off request (Jotform "Student Lesson Confirmation '
  'Form") for an attended SDC lesson. Unique on k_visit, so the hourly sync never '
  'creates or emails a lesson twice. The form fields are snapshotted here as they '
  'were sent; fi_* is the FI as of the day the request was made, because WL keeps '
  'current group membership only.';
comment on column public.lesson_signoff.status is
  'pending: created, email not yet sent (or a send failed - retried next run). '
  'sent: emailed. skipped: not emailed, see skip_reason - re-evaluated every run, '
  'so tagging the FI in WL lets it through. signed: the form came back (phase 2).';
comment on column public.lesson_signoff.course_code is
  'class_title in upper case with " | " as " - ", the format the studio''s forms use.';

create index if not exists lesson_signoff_status_idx
  on public.lesson_signoff (status, dt_start_utc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists member_group_set_updated_at on public.member_group;
create trigger member_group_set_updated_at
  before update on public.member_group
  for each row execute function public.set_updated_at();

drop trigger if exists lesson_signoff_set_updated_at on public.lesson_signoff;
create trigger lesson_signoff_set_updated_at
  before update on public.lesson_signoff
  for each row execute function public.set_updated_at();

-- Staff data: RLS on and no policy, so only the service role reads or writes.
alter table public.member_group        enable row level security;
alter table public.member_group_member enable row level security;
alter table public.lesson_signoff      enable row level security;

-- Spelled out per table rather than looped over a name list: dynamic SQL that
-- concatenates the schema name onto a table name is what tests/app-schema.test.ts
-- forbids after 0047.
do $$
declare n int;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.member_group'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.member_group_member'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.lesson_signoff'::regclass) then
    raise exception '0070: RLS is not enabled on every new table';
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('member_group', 'member_group_member', 'lesson_signoff');
  if n <> 0 then
    raise exception '0070: the new tables have % polic(ies); they must have none', n;
  end if;
end
$$;
