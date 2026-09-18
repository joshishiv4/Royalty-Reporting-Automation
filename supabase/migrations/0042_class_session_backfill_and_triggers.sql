-- =============================================================================
-- 0042  Fill cohort / class_session, and keep them filled - by trigger
--
-- 0041 created the tables. They are inert. This migration makes them true and
-- keeps them true, exactly as 0040 does for identity.
--
-- ONE FILE, for the reason 0040 gives: a session inserted between a backfill and
-- the trigger meant to catch it is lost with nothing anywhere to say so.
--
-- NO SYNC CODE CHANGES. `session` is written by src/sync/sessions.ts and
-- src/sync/client-sessions.ts; `session_staff` by both. Projecting from
-- application code would mean editing every writer and trusting the next one to
-- remember. A trigger cannot be forgotten by a writer that does not know it
-- exists.
--
-- THE `WHEN` CLAUSES LIST COLUMNS ONE BY ONE, AND THAT IS NOT LAZINESS AVOIDED
--   `old.* is distinct from new.*` would have been shorter and would fire on
--   EVERY row EVERY night: `session.synced_at` moves on every pass whether or
--   not anything changed. Only the columns this projection actually reads are
--   listed, so an unchanged re-sync does nothing.
--
--   `UPDATE OF (...)` alone is not enough either - in Postgres that fires when a
--   column APPEARS IN THE STATEMENT, not when its value changes, and the sync's
--   upsert writes all of them every time. Both halves are needed.
--
-- COHORT STUBS. A session may carry a k_class nobody has named. Refusing it
-- would leave the student's next session invisible until an admin did data
-- entry, which fails the requirement this work exists for. So a stub cohort is
-- created, flagged `is_resolved = false`, and the session lands. This is the
-- stub-don't-fail pattern 0012 already uses for `service`.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The whole projection, in one function. Called by the backfill AND the
-- triggers, so the rule has exactly one definition - a backfill written
-- separately is a second copy, and the two drift.
-- -----------------------------------------------------------------------------
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
      from public.cohort_link
     where k_class = v_session.k_class
       and k_business = v_session.k_business;

    if v_cohort_id is null then
      -- Stub it and carry on. Named from the session title, which is the only
      -- name WellnessLiving gives this level, and flagged unresolved so it is
      -- countable rather than indistinguishable from one a human named.
      insert into public.cohort (title, is_resolved)
      values (v_session.text_title, false)
      returning id into v_cohort_id;

      insert into public.cohort_link (k_class, k_business, cohort_id, synced_at)
      values (v_session.k_class, v_session.k_business, v_cohort_id, now())
          on conflict (k_class, k_business) where k_class is not null
          do update set cohort_id = excluded.cohort_id, synced_at = now()
       returning cohort_id into v_cohort_id;
    else
      update public.cohort_link set synced_at = now()
       where k_class = v_session.k_class and k_business = v_session.k_business;

      -- Keep a STUB's title current, but never overwrite one a human resolved.
      -- Their name is the answer; ours was a placeholder standing in for it.
      update public.cohort
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
    from public.session_link
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc;

  if v_cs_id is null then
    insert into public.class_session (
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

    insert into public.session_link (
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
    update public.class_session
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

    update public.session_link set synced_at = now()
     where k_period = p_k_period and dt_start_utc = p_dt_start_utc;
  end if;
end;
$$;

comment on function public.class_session_sync(text, timestamptz) is
  'The single definition of what a WellnessLiving session maps to in cohort and '
  'class_session. Called by the backfill and the triggers so the rule exists '
  'once. Idempotent: no bare INSERT, every update guarded by IS DISTINCT FROM.';

-- -----------------------------------------------------------------------------
-- Who taught it. Resolves the staff key through identity - the person hub from
-- 0039 - which is why this needs no link table of its own.
-- -----------------------------------------------------------------------------
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
    from public.session_link
   where k_period = p_k_period and dt_start_utc = p_dt_start_utc;
  if v_cs_id is null then
    -- The occurrence has not been projected yet. Nothing to attach to, and the
    -- session trigger will arrive; doing nothing is correct rather than creating
    -- a class_session from a staff row that knows almost nothing about it.
    return;
  end if;

  select teacher_id into v_teacher_id
    from public.identity where k_staff = p_k_staff;
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

  insert into public.class_session_teacher (class_session_id, teacher_id, is_substitute)
  values (v_cs_id, v_teacher_id, coalesce(v_is_sub, false))
      on conflict (class_session_id, teacher_id)
      do update set is_substitute = excluded.is_substitute
       where public.class_session_teacher.is_substitute
             is distinct from excluded.is_substitute;
end;
$$;

-- -----------------------------------------------------------------------------
-- TRIGGER 1  session INSERT -> project the occurrence
-- -----------------------------------------------------------------------------
create or replace function public.class_session_on_session_insert()
returns trigger language plpgsql as $$
begin
  perform public.class_session_sync(new.k_period, new.dt_start_utc);
  return null;
end;
$$;

drop trigger if exists session_class_session_insert on public.session;
create trigger session_class_session_insert
  after insert on public.session
  for each row execute function public.class_session_on_session_insert();

-- -----------------------------------------------------------------------------
-- TRIGGER 2  session CHANGES in a column we project -> re-project
-- -----------------------------------------------------------------------------
create or replace function public.class_session_on_session_update()
returns trigger language plpgsql as $$
begin
  perform public.class_session_sync(new.k_period, new.dt_start_utc);
  return null;
end;
$$;

drop trigger if exists session_class_session_update on public.session;
create trigger session_class_session_update
  after update of
    k_class, text_title, dt_end_utc, dtl_start_local, dtl_end_local,
    text_timezone, i_duration_min, i_capacity, i_booked,
    is_cancelled_studio, is_cancelled_client, session_kind, k_location
  on public.session
  for each row
  when (
    (old.k_class, old.text_title, old.dt_end_utc, old.dtl_start_local,
     old.dtl_end_local, old.text_timezone, old.i_duration_min, old.i_capacity,
     old.i_booked, old.is_cancelled_studio, old.is_cancelled_client,
     old.session_kind, old.k_location)
    is distinct from
    (new.k_class, new.text_title, new.dt_end_utc, new.dtl_start_local,
     new.dtl_end_local, new.text_timezone, new.i_duration_min, new.i_capacity,
     new.i_booked, new.is_cancelled_studio, new.is_cancelled_client,
     new.session_kind, new.k_location)
  )
  execute function public.class_session_on_session_update();

-- -----------------------------------------------------------------------------
-- TRIGGER 3  session_staff INSERT or CHANGE -> attach the teacher
-- -----------------------------------------------------------------------------
create or replace function public.class_session_on_staff_change()
returns trigger language plpgsql as $$
begin
  perform public.class_session_sync_teacher(new.k_period, new.dt_start_utc, new.k_staff);
  return null;
end;
$$;

-- TWO TRIGGERS, NOT ONE. `TG_OP` IS NOT AVAILABLE IN A `WHEN` CLAUSE.
--
-- This was written as a single `after insert or update of` whose WHEN read
-- `tg_op = 'INSERT' or old.is_substitute is distinct from new.is_substitute`,
-- and Postgres rejected it:
--
--   ERROR: 42703: column "tg_op" does not exist
--
-- TG_OP is a PL/pgSQL variable that exists inside a trigger FUNCTION BODY. A
-- WHEN clause is a plain SQL expression over OLD and NEW, and has no such thing.
-- Correcting only that spelling would fail again on the next term, because OLD
-- does not exist on an INSERT at all - so no single condition can cover both
-- operations. 0040 hit this first and split the same way.
--
-- Moving the test inside the function would compile and would be worse: the
-- function is then CALLED on every statement naming the column and decides to do
-- nothing, which is the exact cost the WHEN clause exists to avoid.
drop trigger if exists session_staff_class_session on public.session_staff;

drop trigger if exists session_staff_class_session_insert on public.session_staff;
create trigger session_staff_class_session_insert
  after insert on public.session_staff
  for each row
  execute function public.class_session_on_staff_change();

drop trigger if exists session_staff_class_session_update on public.session_staff;
create trigger session_staff_class_session_update
  after update of is_substitute on public.session_staff
  for each row
  when (old.is_substitute is distinct from new.is_substitute)
  execute function public.class_session_on_staff_change();

-- -----------------------------------------------------------------------------
-- TRIGGER 4  a person becomes a teacher -> attach them to sessions already
--            projected without them
-- -----------------------------------------------------------------------------
-- WITHOUT THIS THE TEACHER IS PERMANENTLY MISSING FROM OLD SESSIONS.
-- class_session_sync_teacher gives up when identity has no teacher_id yet, which
-- is the ordinary state for a stub person - and nothing would ever call it
-- again, because session_staff is not touched when the person is enriched.
-- Every session they taught before that moment would show no teacher, for ever.
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

-- Split for the same reason as the pair above: no TG_OP in a WHEN clause, and no
-- OLD on an INSERT.
drop trigger if exists identity_class_session_teacher on public.identity;

drop trigger if exists identity_class_session_teacher_insert on public.identity;
create trigger identity_class_session_teacher_insert
  after insert on public.identity
  for each row
  when (pg_trigger_depth() < 3 and new.teacher_id is not null)
  execute function public.class_session_on_identity_role();

drop trigger if exists identity_class_session_teacher_update on public.identity;
create trigger identity_class_session_teacher_update
  after update of teacher_id on public.identity
  for each row
  when (
    pg_trigger_depth() < 3
    and new.teacher_id is not null
    and old.teacher_id is distinct from new.teacher_id
  )
  execute function public.class_session_on_identity_role();

-- -----------------------------------------------------------------------------
-- THE BACKFILL. Same file, same transaction, for the reason in the header.
--
-- Sessions first, then staff: a staff row whose occurrence has not been
-- projected yet is dropped on the floor by design, so the order is not cosmetic.
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select k_period, dt_start_utc from public.session
            order by dt_start_utc, k_period loop
    perform public.class_session_sync(r.k_period, r.dt_start_utc);
  end loop;

  for r in select k_period, dt_start_utc, k_staff from public.session_staff loop
    perform public.class_session_sync_teacher(r.k_period, r.dt_start_utc, r.k_staff);
  end loop;
end;
$$;
