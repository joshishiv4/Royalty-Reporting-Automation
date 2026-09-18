-- =============================================================================
-- 0044  Fill attendance_record, and keep it filled - by trigger
--
-- 0043 created the tables. This makes them true and keeps them true.
--
-- ONE FILE, for the reason 0040 and 0042 both give: a row inserted between a
-- backfill and the trigger meant to catch it is lost with nothing to say so.
--
-- THE BACKFILL IS SET-BASED, AND THAT IS A DEPARTURE ON PURPOSE
--   0040 and 0042 loop row by row, which is clear and was fast enough at 1,285
--   people and 44,499 sessions. Attendance is one row per attendee per occurrence
--   for ever - the largest table here. A PL/pgSQL loop over several hundred
--   thousand rows in the Supabase SQL editor is a statement timeout, not a slow
--   success, and a backfill that dies half way leaves exactly the silent gap this
--   file exists to prevent. Two INSERT ... SELECT statements do the same work in
--   one pass each.
--
--   The TRIGGER path stays row-at-a-time, because that is what a trigger is.
--
-- WHAT IS DELIBERATELY NOT PROJECTED
--   An attendance whose person resolves to a TEACHER rather than a student.
--   `attendance_record.student_id` is not null, and under the rule confirmed
--   17 Sep 2026 a person is one or the other. A staff member who attends a class
--   as a client is therefore absent from this table - visible in the WL mirror,
--   absent from the portal's view. That is a consequence of the role rule, not a
--   bug in this migration, and it is written down here so it is recognised rather
--   than rediscovered.
--
--   An attendance whose person has NO role yet (a stub - see 0040) is also
--   skipped, and trigger 3 below is what picks them up when the role arrives.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- FIRST: make is_attended nullable, for a database that took 0043's first draft.
--
-- 0043 originally declared it `not null default false`, reintroducing the exact
-- claim 0029 removed from `attendance`: that every visit was NOT attended until
-- proven otherwise. A session that has not happened yet, or one WL has left
-- PENDING for staff, has no answer - and this is the column a student's own
-- attendance record is read from.
--
-- 0043 is corrected for a fresh database. This is here for one that already ran
-- the first draft, and it is a no-op on a correct schema.
-- -----------------------------------------------------------------------------
alter table public.attendance_record alter column is_attended drop default;
alter table public.attendance_record alter column is_attended drop not null;

comment on column public.attendance_record.is_attended is
  'True only when WellnessLiving says the student attended. NULL means not yet '
  'known - the session is upcoming, or WL has it PENDING. Nullable on purpose: '
  'coalescing it to false would turn "no idea" into "did not turn up".';

-- -----------------------------------------------------------------------------
-- The projection for ONE attendance row. Used by the triggers.
--
-- The backfill does NOT call this - see the header. That means the rule has two
-- expressions, which is a cost; it is accepted because the alternative is a
-- backfill that cannot finish. The column lists are kept adjacent so a change to
-- one is visibly a change to the other.
-- -----------------------------------------------------------------------------
create or replace function public.attendance_record_sync(
  p_k_period     text,
  p_dt_start_utc timestamptz,
  p_uid          text
)
returns void
language plpgsql
as $$
declare
  v_a          public.attendance%rowtype;
  v_cs_id      uuid;
  v_student_id uuid;
  v_rec_id     uuid;
begin
  select * into v_a
    from public.attendance
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc and uid = p_uid;
  if not found then
    return;
  end if;

  select class_session_id into v_cs_id
    from public.session_link
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc;

  select student_id into v_student_id
    from public.identity where uid = p_uid;

  -- Either half unresolved: do nothing, and wait. Inventing a class_session or a
  -- student here would make this a second source for a fact another table owns.
  if v_cs_id is null or v_student_id is null then
    return;
  end if;

  insert into public.attendance_record (
    class_session_id, student_id,
    is_attended, is_no_show, is_cancelled_client, is_cancelled_studio,
    is_late_cancel, is_waitlisted,
    booked_at, checked_in_at, cancelled_at
  ) values (
    v_cs_id, v_student_id,
    v_a.is_attended, v_a.is_no_show, v_a.is_cancelled_client, v_a.is_cancelled_studio,
    v_a.is_late_cancel, v_a.is_waitlisted,
    v_a.dt_booked_utc, v_a.dt_checkin_utc, v_a.dt_cancelled_utc
  )
  on conflict (class_session_id, student_id) do update
     set is_attended         = excluded.is_attended,
         is_no_show          = excluded.is_no_show,
         is_cancelled_client = excluded.is_cancelled_client,
         is_cancelled_studio = excluded.is_cancelled_studio,
         is_late_cancel      = excluded.is_late_cancel,
         is_waitlisted       = excluded.is_waitlisted,
         booked_at           = excluded.booked_at,
         checked_in_at       = excluded.checked_in_at,
         cancelled_at        = excluded.cancelled_at
   -- Without this the UPDATE fires on every row of every nightly pass and
   -- attendance_record_set_updated_at moves updated_at on all of them, which
   -- makes "what changed recently" answer "everything, every night".
   where (public.attendance_record.is_attended,
          public.attendance_record.is_no_show,
          public.attendance_record.is_cancelled_client,
          public.attendance_record.is_cancelled_studio,
          public.attendance_record.is_late_cancel,
          public.attendance_record.is_waitlisted,
          public.attendance_record.booked_at,
          public.attendance_record.checked_in_at,
          public.attendance_record.cancelled_at)
         is distinct from
         (excluded.is_attended, excluded.is_no_show, excluded.is_cancelled_client,
          excluded.is_cancelled_studio, excluded.is_late_cancel,
          excluded.is_waitlisted, excluded.booked_at, excluded.checked_in_at,
          excluded.cancelled_at)
  returning id into v_rec_id;

  -- The upsert returns nothing when the DO UPDATE was filtered out by the guard
  -- above - an unchanged row. Read the id instead; it is the same row.
  if v_rec_id is null then
    select id into v_rec_id from public.attendance_record
     where class_session_id = v_cs_id and student_id = v_student_id;
  end if;

  insert into public.attendance_link (
    k_period, dt_start_utc, uid, k_business, attendance_record_id, synced_at
  ) values (
    p_k_period, p_dt_start_utc, p_uid, v_a.k_business, v_rec_id, now()
  )
  on conflict (k_period, dt_start_utc, uid) where k_period is not null
  do update set attendance_record_id = excluded.attendance_record_id,
                synced_at            = now();
end;
$$;

comment on function public.attendance_record_sync(text, timestamptz, text) is
  'Projects ONE WellnessLiving attendance row into attendance_record plus its '
  'link. Idempotent. Does nothing when the session or the student is not yet '
  'resolved - trigger 3 picks those up when the role arrives.';

-- -----------------------------------------------------------------------------
-- TRIGGER 1  attendance INSERT
-- -----------------------------------------------------------------------------
create or replace function public.attendance_record_on_insert()
returns trigger language plpgsql as $$
begin
  perform public.attendance_record_sync(new.k_period, new.dt_start_utc, new.uid);
  return null;
end;
$$;

drop trigger if exists attendance_record_insert on public.attendance;
create trigger attendance_record_insert
  after insert on public.attendance
  for each row execute function public.attendance_record_on_insert();

-- -----------------------------------------------------------------------------
-- TRIGGER 2  attendance CHANGES in a projected column
-- -----------------------------------------------------------------------------
-- The columns are listed one by one rather than `old.* is distinct from new.*`,
-- which would fire on every row every night: attendance.synced_at moves on every
-- pass whether or not anything changed. `UPDATE OF` alone is not enough either -
-- it fires when a column appears in the statement, not when its value changes.
create or replace function public.attendance_record_on_update()
returns trigger language plpgsql as $$
begin
  perform public.attendance_record_sync(new.k_period, new.dt_start_utc, new.uid);
  return null;
end;
$$;

drop trigger if exists attendance_record_update on public.attendance;
create trigger attendance_record_update
  after update of
    is_attended, is_no_show, is_cancelled_client, is_cancelled_studio,
    is_late_cancel, is_waitlisted, dt_booked_utc, dt_checkin_utc, dt_cancelled_utc
  on public.attendance
  for each row
  when (
    (old.is_attended, old.is_no_show, old.is_cancelled_client,
     old.is_cancelled_studio, old.is_late_cancel, old.is_waitlisted,
     old.dt_booked_utc, old.dt_checkin_utc, old.dt_cancelled_utc)
    is distinct from
    (new.is_attended, new.is_no_show, new.is_cancelled_client,
     new.is_cancelled_studio, new.is_late_cancel, new.is_waitlisted,
     new.dt_booked_utc, new.dt_checkin_utc, new.dt_cancelled_utc)
  )
  execute function public.attendance_record_on_update();

-- -----------------------------------------------------------------------------
-- TRIGGER 3  a person becomes a student -> project the attendance they already
--            had
-- -----------------------------------------------------------------------------
-- WITHOUT THIS, A STUB PERSON'S HISTORY IS PERMANENTLY MISSING.
-- attendance_record_sync gives up when identity has no student_id, which is the
-- ordinary state for a stub (0040). Nothing would ever call it again: the
-- attendance rows are not rewritten when the person is later enriched, so every
-- class they had already attended would be absent for ever.
--
-- This is the same hole 0042 closes for teachers, one table along.
create or replace function public.attendance_record_on_identity_role()
returns trigger language plpgsql as $$
declare
  r record;
begin
  if new.student_id is null or new.uid is null then
    return null;
  end if;
  for r in
    select a.k_period, a.dt_start_utc, a.uid
      from public.attendance a
     where a.uid = new.uid
  loop
    perform public.attendance_record_sync(r.k_period, r.dt_start_utc, r.uid);
  end loop;
  return null;
end;
$$;

-- Split into INSERT and UPDATE: TG_OP is not available in a WHEN clause, and OLD
-- does not exist on an INSERT. 0040 and 0042 both hit this.
drop trigger if exists identity_attendance_record_insert on public.identity;
create trigger identity_attendance_record_insert
  after insert on public.identity
  for each row
  when (pg_trigger_depth() < 3 and new.student_id is not null)
  execute function public.attendance_record_on_identity_role();

drop trigger if exists identity_attendance_record_update on public.identity;
create trigger identity_attendance_record_update
  after update of student_id on public.identity
  for each row
  when (
    pg_trigger_depth() < 3
    and new.student_id is not null
    and old.student_id is distinct from new.student_id
  )
  execute function public.attendance_record_on_identity_role();

-- -----------------------------------------------------------------------------
-- THE BACKFILL, set-based. Two statements, one pass each.
-- -----------------------------------------------------------------------------
insert into public.attendance_record (
  class_session_id, student_id,
  is_attended, is_no_show, is_cancelled_client, is_cancelled_studio,
  is_late_cancel, is_waitlisted,
  booked_at, checked_in_at, cancelled_at
)
select sl.class_session_id, i.student_id,
       a.is_attended, a.is_no_show, a.is_cancelled_client, a.is_cancelled_studio,
       a.is_late_cancel, a.is_waitlisted,
       a.dt_booked_utc, a.dt_checkin_utc, a.dt_cancelled_utc
  from public.attendance a
  join public.session_link sl
    on sl.k_period = a.k_period and sl.dt_start_utc = a.dt_start_utc
   and sl.class_session_id is not null
  join public.identity i
    on i.uid = a.uid and i.student_id is not null
    on conflict (class_session_id, student_id) do update
       set is_attended         = excluded.is_attended,
           is_no_show          = excluded.is_no_show,
           is_cancelled_client = excluded.is_cancelled_client,
           is_cancelled_studio = excluded.is_cancelled_studio,
           is_late_cancel      = excluded.is_late_cancel,
           is_waitlisted       = excluded.is_waitlisted,
           booked_at           = excluded.booked_at,
           checked_in_at       = excluded.checked_in_at,
           cancelled_at        = excluded.cancelled_at
     -- The same guard the trigger uses, for the same reason. This migration is
     -- safe to re-run, and without it a second run would rewrite every row and
     -- move updated_at on all of them - which would make "what changed recently"
     -- report the re-run rather than the data.
     where (public.attendance_record.is_attended,
            public.attendance_record.is_no_show,
            public.attendance_record.is_cancelled_client,
            public.attendance_record.is_cancelled_studio,
            public.attendance_record.is_late_cancel,
            public.attendance_record.is_waitlisted,
            public.attendance_record.booked_at,
            public.attendance_record.checked_in_at,
            public.attendance_record.cancelled_at)
           is distinct from
           (excluded.is_attended, excluded.is_no_show, excluded.is_cancelled_client,
            excluded.is_cancelled_studio, excluded.is_late_cancel,
            excluded.is_waitlisted, excluded.booked_at, excluded.checked_in_at,
            excluded.cancelled_at);

insert into public.attendance_link (
  k_period, dt_start_utc, uid, k_business, attendance_record_id, synced_at
)
select a.k_period, a.dt_start_utc, a.uid, a.k_business, ar.id, now()
  from public.attendance a
  join public.session_link sl
    on sl.k_period = a.k_period and sl.dt_start_utc = a.dt_start_utc
   and sl.class_session_id is not null
  join public.identity i
    on i.uid = a.uid and i.student_id is not null
  join public.attendance_record ar
    on ar.class_session_id = sl.class_session_id and ar.student_id = i.student_id
    on conflict (k_period, dt_start_utc, uid) where k_period is not null
    do update set attendance_record_id = excluded.attendance_record_id,
                  synced_at            = now();
