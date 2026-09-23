-- =============================================================================
-- 0047  The portal's eleven tables move to their own schema, `app`
--
-- WHY A SCHEMA AT ALL
--   public holds two populations that were never the same thing: the
--   WellnessLiving mirror the sync writes, and the eleven tables the portal
--   reads. They sat together because the projection was built where the mirror
--   already was, not because anything wanted them there.
--
--   The separation buys one concrete thing, and it is not tidiness. PostgREST
--   is told which schemas to expose. With one schema, exposing the portal's
--   tables exposes `purchase`, `pay_transaction` and `raw_wl` alongside them,
--   and the only thing standing between a misconfigured role and the money is
--   RLS with no policies on it. With two, the portal's schema is the one that
--   is reachable and the mirror is not addressable at all.
--
-- WHAT DOES NOT CHANGE, MEASURED RATHER THAN ASSUMED
--   * Foreign keys cross schemas. app.identity.uid still references
--     public.person(uid); app.session_link still references public.session.
--     Nothing here drops a key to buy the move.
--   * Triggers cross schemas. The projection triggers stay on public.person,
--     public.session, public.session_staff and public.attendance and go on
--     writing into app.
--   * The four triggers that sit ON identity travel with the table, because
--     SET SCHEMA carries a table's triggers.
--   * Views bind to an OID, not to a name, so nothing that selects from a moved
--     table needs restating.
--   * src/ is untouched. The sync writes person, session and attendance - all
--     of which stay in public - and never addresses one of the eleven. The
--     projection reaches them by trigger, which is why this is a schema change
--     and not a code change.
--
-- WHAT DOES CHANGE OUTSIDE THIS FILE
--   * Supabase must expose `app` to PostgREST (Settings -> API -> Exposed
--     schemas). Until it does, the portal reads nothing.
--   * The portal's Supabase client needs db: { schema: 'app' }.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The schema.
-- -----------------------------------------------------------------------------
create schema if not exists app;

comment on schema app is
  'The portal owns these tables. No WellnessLiving key appears on any of them - '
  'those live on the link tables and on identity, which are the translation. '
  'public holds the WellnessLiving mirror the sync writes.';

grant usage on schema app to anon, authenticated, service_role;
grant all on all tables    in schema app to service_role;
grant all on all sequences in schema app to service_role;
grant all on all functions in schema app to service_role;

alter default privileges in schema app
  grant all on tables to service_role;
alter default privileges in schema app
  grant all on sequences to service_role;

-- -----------------------------------------------------------------------------
-- 2. Move the eleven owned tables.
--
-- SET SCHEMA carries the table's indexes, constraints, foreign keys in BOTH
-- directions, triggers, RLS policies, comments and owned sequences with it.
-- Nothing in that list needs restating here, and restating it would be a second
-- copy of a fact the catalogue already holds.
--
-- Guarded by a catalogue lookup rather than by IF NOT EXISTS, which SET SCHEMA
-- does not offer, so this file is safe to re-run.
-- -----------------------------------------------------------------------------
do $move$
begin
  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'class_session_teacher'
  ) then
    execute 'alter table public.class_session_teacher set schema app';
    raise notice '  moved public.class_session_teacher -> app.class_session_teacher';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'attendance_record'
  ) then
    execute 'alter table public.attendance_record set schema app';
    raise notice '  moved public.attendance_record -> app.attendance_record';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'attendance_link'
  ) then
    execute 'alter table public.attendance_link set schema app';
    raise notice '  moved public.attendance_link -> app.attendance_link';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'session_link'
  ) then
    execute 'alter table public.session_link set schema app';
    raise notice '  moved public.session_link -> app.session_link';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'cohort_link'
  ) then
    execute 'alter table public.cohort_link set schema app';
    raise notice '  moved public.cohort_link -> app.cohort_link';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'class_session'
  ) then
    execute 'alter table public.class_session set schema app';
    raise notice '  moved public.class_session -> app.class_session';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'identity'
  ) then
    execute 'alter table public.identity set schema app';
    raise notice '  moved public.identity -> app.identity';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'student'
  ) then
    execute 'alter table public.student set schema app';
    raise notice '  moved public.student -> app.student';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'teacher'
  ) then
    execute 'alter table public.teacher set schema app';
    raise notice '  moved public.teacher -> app.teacher';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'cohort'
  ) then
    execute 'alter table public.cohort set schema app';
    raise notice '  moved public.cohort -> app.cohort';
  end if;

  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'creation'
  ) then
    execute 'alter table public.creation set schema app';
    raise notice '  moved public.creation -> app.creation';
  end if;
end
$move$;

-- -----------------------------------------------------------------------------
-- 3. The fourteen projection functions, re-pointed.
--
-- THIS IS THE PART SET SCHEMA CANNOT DO, AND THE REASON IT IS DANGEROUS.
--
-- A plpgsql body resolves its table references when it RUNS, not when it is
-- created. Moving a table therefore does not error, does not warn, and does not
-- touch the function that reads it - the break arrives on the next INSERT, as
--
--     relation "public.cohort_link" does not exist
--
-- raised from inside a trigger on public.session, which fails the sync's own
-- write. Loud when it happens, invisible until then. So the move and the
-- re-point belong in ONE file: a database that has had the first without the
-- second is a database whose next sync pass dies.
--
-- The functions themselves STAY in public. Their triggers sit on public.person,
-- public.session, public.attendance and public.session_staff - machinery on the
-- mirror side - and moving them would buy a tidier name for 48 more edits.
--
-- public.set_updated_at is NOT re-pointed either: it is shared with the mirror
-- tables (0005, 0006), and the moved tables go on calling it across the schema
-- boundary, which Postgres allows.
-- -----------------------------------------------------------------------------

create or replace function public.identity_sync_person(p_uid text)
returns void
language plpgsql
as $$
declare
  v_person      public.person%rowtype;
  v_identity_id uuid;
  v_student_id  uuid;
  v_teacher_id  uuid;
  v_is_teacher  boolean;
  v_role_known  boolean;
begin
  select * into v_person from public.person where uid = p_uid;
  if not found then
    return;
  end if;

  -- The role. NULL k_login_type means "not yet known", NOT "student".
  v_role_known := v_person.k_login_type is not null;

  if v_role_known then
    select coalesce(bool_or(lt.is_teacher_type), false)
      into v_is_teacher
      from public.login_type lt
     where lt.k_login_type = v_person.k_login_type
       and lt.k_business   = v_person.k_business;
    v_is_teacher := coalesce(v_is_teacher, false);
  end if;

  -- ---------------------------------------------------------------------------
  -- The hub row. Conflict target is the partial unique index on uid, which is why
  -- the predicate is repeated - Postgres needs it to infer a partial index.
  -- ---------------------------------------------------------------------------
  insert into app.identity (uid, k_staff, k_business, ghl_contact_id, synced_at)
  values (v_person.uid, v_person.k_staff, v_person.k_business,
          v_person.ghl_contact_id, now())
      on conflict (uid) where uid is not null
      do update set k_staff        = excluded.k_staff,
                    k_business     = excluded.k_business,
                    ghl_contact_id = excluded.ghl_contact_id,
                    synced_at      = now()
   returning id, student_id, teacher_id
        into v_identity_id, v_student_id, v_teacher_id;

  if not v_role_known then
    -- Nothing more to do. The identity exists, the role waits for enrichment, and
    -- an existing role (if this person once had a login type) is deliberately
    -- left alone - losing a type is not evidence of becoming somebody else.
    return;
  end if;

  if v_is_teacher then
    -- -------------------------------------------------------------------------
    -- Becoming a teacher. The student row, if there was one, is UNLINKED and NOT
    -- deleted.
    --
    -- Deleting it would be tidier and is wrong: once progress, feedback and
    -- projects hang off a student row, a nightly sync would be silently
    -- destroying portal-authored data because somebody changed a type in
    -- WellnessLiving. An orphan is visible and recoverable; a delete is neither.
    -- The health check in task 1.8 counts orphans.
    -- -------------------------------------------------------------------------
    if v_teacher_id is null then
      insert into app.teacher (first_name, last_name, email, phone)
      values (v_person.first_name, v_person.last_name, v_person.email,
              v_person.phone)
      returning id into v_teacher_id;

      update app.identity
         set teacher_id = v_teacher_id,
             student_id = null
       where id = v_identity_id;
    else
      update app.teacher
         set first_name = v_person.first_name,
             last_name  = v_person.last_name,
             email      = v_person.email,
             phone      = v_person.phone
       where id = v_teacher_id
         and (first_name, last_name, email, phone)
             is distinct from
             (v_person.first_name, v_person.last_name, v_person.email,
              v_person.phone);

      if v_student_id is not null then
        update app.identity set student_id = null where id = v_identity_id;
      end if;
    end if;

  else
    if v_student_id is null then
      insert into app.student (first_name, last_name, email, phone,
                                  date_of_birth)
      values (v_person.first_name, v_person.last_name, v_person.email,
              v_person.phone, v_person.date_of_birth)
      returning id into v_student_id;

      update app.identity
         set student_id = v_student_id,
             teacher_id = null
       where id = v_identity_id;
    else
      -- The IS DISTINCT FROM guard is not decoration. Without it this UPDATE fires
      -- on every person on every nightly pass, and student_set_updated_at moves
      -- updated_at on all of them - which makes "what changed recently" answer
      -- "everything, every night" and useless.
      update app.student
         set first_name    = v_person.first_name,
             last_name     = v_person.last_name,
             email         = v_person.email,
             phone         = v_person.phone,
             date_of_birth = v_person.date_of_birth
       where id = v_student_id
         and (first_name, last_name, email, phone, date_of_birth)
             is distinct from
             (v_person.first_name, v_person.last_name, v_person.email,
              v_person.phone, v_person.date_of_birth);

      if v_teacher_id is not null then
        update app.identity set teacher_id = null where id = v_identity_id;
      end if;
    end if;
  end if;
end;
$$;

create or replace function public.identity_on_person_insert()
returns trigger
language plpgsql
as $$
begin
  perform public.identity_sync_person(new.uid);
  return null;
end;
$$;

create or replace function public.identity_on_person_login_type_change()
returns trigger
language plpgsql
as $$
begin
  perform public.identity_sync_person(new.uid);
  return null;
end;
$$;

create or replace function public.identity_on_teacher_rule_change()
returns trigger
language plpgsql
as $$
declare
  v_uid text;
begin
  for v_uid in
    select p.uid
      from public.person p
     where p.k_login_type = new.k_login_type
       and p.k_business   = new.k_business
  loop
    perform public.identity_sync_person(v_uid);
  end loop;
  return null;
end;
$$;

create or replace function public.class_session_sync(
  p_k_period     text,
  p_dt_start_utc timestamptz
)
returns void
language plpgsql
as $$
declare
  v_session   public.session%rowtype;
  v_cohort_id uuid;
  v_cs_id     uuid;
  v_location  text;
begin
  select * into v_session
    from public.session
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc;
  if not found then
    return;
  end if;

  -- ---------------------------------------------------------------------------
  -- The cohort. Only a class has a series; an appointment does not, and giving
  -- one a cohort would invent a class group that does not exist.
  -- ---------------------------------------------------------------------------
  if v_session.k_class is not null then
    select cohort_id into v_cohort_id
      from app.cohort_link
     where k_class = v_session.k_class
       and k_business = v_session.k_business;

    if v_cohort_id is null then
      -- Stub it and carry on. Named from the session title, which is the only
      -- name WellnessLiving gives this level, and flagged unresolved so it is
      -- countable rather than indistinguishable from one a human named.
      insert into app.cohort (title, is_resolved)
      values (v_session.text_title, false)
      returning id into v_cohort_id;

      insert into app.cohort_link (k_class, k_business, cohort_id, synced_at)
      values (v_session.k_class, v_session.k_business, v_cohort_id, now())
          on conflict (k_class, k_business) where k_class is not null
          do update set cohort_id = excluded.cohort_id, synced_at = now()
       returning cohort_id into v_cohort_id;
    else
      update app.cohort_link set synced_at = now()
       where k_class = v_session.k_class and k_business = v_session.k_business;

      -- Keep a STUB's title current, but never overwrite one a human resolved.
      -- Their name is the answer; ours was a placeholder standing in for it.
      update app.cohort
         set title = v_session.text_title
       where id = v_cohort_id
         and not is_resolved
         and title is distinct from v_session.text_title;
    end if;
  end if;

  select title into v_location
    from public.location where k_location = v_session.k_location;

  -- ---------------------------------------------------------------------------
  -- The occurrence. The link is the conflict target, so a re-sync resolves to
  -- UPDATE and never mints a second class_session for a session WL has already
  -- sent - the same failure 0034 was written to avoid one level down.
  -- ---------------------------------------------------------------------------
  select class_session_id into v_cs_id
    from app.session_link
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc;

  if v_cs_id is null then
    insert into app.class_session (
      cohort_id, title, starts_at, ends_at, local_start, local_end,
      timezone_label, duration_minutes, capacity, booked_count, is_cancelled,
      kind, location_title
    ) values (
      v_cohort_id, v_session.text_title, v_session.dt_start_utc, v_session.dt_end_utc,
      v_session.dtl_start_local, v_session.dtl_end_local, v_session.text_timezone,
      v_session.i_duration_min, v_session.i_capacity, v_session.i_booked,
      v_session.is_cancelled_studio or v_session.is_cancelled_client,
      v_session.session_kind, v_location
    )
    returning id into v_cs_id;

    insert into app.session_link (
      k_period, dt_start_utc, k_business, class_session_id, synced_at
    ) values (
      p_k_period, p_dt_start_utc, v_session.k_business, v_cs_id, now()
    )
    on conflict (k_period, dt_start_utc) where k_period is not null
    do update set class_session_id = excluded.class_session_id, synced_at = now();
  else
    -- The IS DISTINCT FROM guard is not decoration. Without it this UPDATE fires
    -- on every session on every pass, and class_session_set_updated_at moves
    -- updated_at on all of them - which makes "what changed recently" answer
    -- "everything, every night" and useless.
    update app.class_session
       set cohort_id        = v_cohort_id,
           title            = v_session.text_title,
           starts_at        = v_session.dt_start_utc,
           ends_at          = v_session.dt_end_utc,
           local_start      = v_session.dtl_start_local,
           local_end        = v_session.dtl_end_local,
           timezone_label   = v_session.text_timezone,
           duration_minutes = v_session.i_duration_min,
           capacity         = v_session.i_capacity,
           booked_count     = v_session.i_booked,
           is_cancelled     = v_session.is_cancelled_studio or v_session.is_cancelled_client,
           kind             = v_session.session_kind,
           location_title   = v_location
     where id = v_cs_id
       and (cohort_id, title, starts_at, ends_at, local_start, local_end,
            timezone_label, duration_minutes, capacity, booked_count,
            is_cancelled, kind, location_title)
           is distinct from
           (v_cohort_id, v_session.text_title, v_session.dt_start_utc,
            v_session.dt_end_utc, v_session.dtl_start_local, v_session.dtl_end_local,
            v_session.text_timezone, v_session.i_duration_min, v_session.i_capacity,
            v_session.i_booked,
            v_session.is_cancelled_studio or v_session.is_cancelled_client,
            v_session.session_kind, v_location);

    update app.session_link set synced_at = now()
     where k_period = p_k_period and dt_start_utc = p_dt_start_utc;
  end if;
end;
$$;

create or replace function public.class_session_sync_teacher(
  p_k_period     text,
  p_dt_start_utc timestamptz,
  p_k_staff      text
)
returns void
language plpgsql
as $$
declare
  v_cs_id      uuid;
  v_teacher_id uuid;
  v_is_sub     boolean;
begin
  select class_session_id into v_cs_id
    from app.session_link
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc;
  if v_cs_id is null then
    -- The occurrence has not been projected yet. Nothing to attach to, and the
    -- session trigger will arrive; doing nothing is correct rather than creating
    -- a class_session from a staff row that knows almost nothing about it.
    return;
  end if;

  select teacher_id into v_teacher_id
    from app.identity where k_staff = p_k_staff;
  if v_teacher_id is null then
    -- Either this person is not in identity yet, or their role is still unknown
    -- (a stub, see 0040). Both are ordinary states that resolve themselves; a
    -- teacher invented here would be a second source for a fact identity owns.
    return;
  end if;

  select is_substitute into v_is_sub
    from public.session_staff
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc
     and k_staff = p_k_staff;

  insert into app.class_session_teacher (class_session_id, teacher_id, is_substitute)
  values (v_cs_id, v_teacher_id, coalesce(v_is_sub, false))
      on conflict (class_session_id, teacher_id)
      do update set is_substitute = excluded.is_substitute
       where app.class_session_teacher.is_substitute
             is distinct from excluded.is_substitute;
end;
$$;

create or replace function public.class_session_on_session_insert()
returns trigger language plpgsql as $$
begin
  perform public.class_session_sync(new.k_period, new.dt_start_utc);
  return null;
end;
$$;

create or replace function public.class_session_on_session_update()
returns trigger language plpgsql as $$
begin
  perform public.class_session_sync(new.k_period, new.dt_start_utc);
  return null;
end;
$$;

create or replace function public.class_session_on_staff_change()
returns trigger language plpgsql as $$
begin
  perform public.class_session_sync_teacher(new.k_period, new.dt_start_utc, new.k_staff);
  return null;
end;
$$;

create or replace function public.class_session_on_identity_role()
returns trigger language plpgsql as $$
declare
  r record;
begin
  if new.teacher_id is null or new.k_staff is null then
    return null;
  end if;
  for r in
    select ss.k_period, ss.dt_start_utc, ss.k_staff
      from public.session_staff ss
     where ss.k_staff = new.k_staff
  loop
    perform public.class_session_sync_teacher(r.k_period, r.dt_start_utc, r.k_staff);
  end loop;
  return null;
end;
$$;

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
    from app.session_link
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc;

  select student_id into v_student_id
    from app.identity where uid = p_uid;

  -- Either half unresolved: do nothing, and wait. Inventing a class_session or a
  -- student here would make this a second source for a fact another table owns.
  if v_cs_id is null or v_student_id is null then
    return;
  end if;

  insert into app.attendance_record (
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
   where (app.attendance_record.is_attended,
          app.attendance_record.is_no_show,
          app.attendance_record.is_cancelled_client,
          app.attendance_record.is_cancelled_studio,
          app.attendance_record.is_late_cancel,
          app.attendance_record.is_waitlisted,
          app.attendance_record.booked_at,
          app.attendance_record.checked_in_at,
          app.attendance_record.cancelled_at)
         is distinct from
         (excluded.is_attended, excluded.is_no_show, excluded.is_cancelled_client,
          excluded.is_cancelled_studio, excluded.is_late_cancel,
          excluded.is_waitlisted, excluded.booked_at, excluded.checked_in_at,
          excluded.cancelled_at)
  returning id into v_rec_id;

  -- The upsert returns nothing when the DO UPDATE was filtered out by the guard
  -- above - an unchanged row. Read the id instead; it is the same row.
  if v_rec_id is null then
    select id into v_rec_id from app.attendance_record
     where class_session_id = v_cs_id and student_id = v_student_id;
  end if;

  insert into app.attendance_link (
    k_period, dt_start_utc, uid, k_business, attendance_record_id, synced_at
  ) values (
    p_k_period, p_dt_start_utc, p_uid, v_a.k_business, v_rec_id, now()
  )
  on conflict (k_period, dt_start_utc, uid) where k_period is not null
  do update set attendance_record_id = excluded.attendance_record_id,
                synced_at            = now();
end;
$$;

create or replace function public.attendance_record_on_insert()
returns trigger language plpgsql as $$
begin
  perform public.attendance_record_sync(new.k_period, new.dt_start_utc, new.uid);
  return null;
end;
$$;

create or replace function public.attendance_record_on_update()
returns trigger language plpgsql as $$
begin
  perform public.attendance_record_sync(new.k_period, new.dt_start_utc, new.uid);
  return null;
end;
$$;

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
