-- =============================================================================
-- 0045  Reconcile the projections - fill whatever the triggers did not
--
-- WHAT THIS IS FOR
--   Every projection in 0040, 0042 and 0044 is trigger-maintained, and a trigger
--   only ever sees rows written AFTER it existed. That is covered: each of those
--   migrations ships its own backfill in the same file, precisely so nothing that
--   predates the trigger is stranded.
--
--   This file is for the case those backfills cannot cover - the gap that opens
--   LATER:
--
--     * a trigger dropped by hand during an incident and restored afterwards
--     * a bulk load that ran with session_replication_role = replica
--     * a projection whose second half was unresolved at the time and whose
--       catch-up trigger was itself missing
--     * a restore from a backup taken between two migrations
--
--   None of those raise an error. Rows simply stop appearing, and the first sign
--   is a student whose portal is emptier than WellnessLiving says it should be.
--
-- IT ONLY TOUCHES WHAT IS MISSING
--   Every statement is driven by a NOT EXISTS. On a healthy database this does
--   nothing at all and finishes in seconds - which is what makes it safe to run
--   whenever anybody is unsure, rather than something to be scheduled and
--   forgotten.
--
--   That is also why it is not a copy of the backfills. Re-running 0042 would
--   walk all 44,499 sessions to discover that 44,499 of them are already correct.
--
-- IT REPORTS. Each section raises a NOTICE with what it repaired. A reconcile
-- that fixes 12,000 rows and says nothing is indistinguishable from one that
-- fixed none, and the difference is the whole reason to run it.
--
-- IT DEFINES NOTHING. No tables, no functions, no triggers - it calls the
-- functions 0040, 0042 and 0044 already own, so the rule it applies is the same
-- rule the triggers apply. A reconcile with its own copy of the logic would
-- eventually disagree with the thing it is meant to be checking.
--
-- Safe to re-run. Safe to run when nothing is wrong.
-- =============================================================================

do $$
declare
  v_count integer;
  r       record;
begin
  -- ---------------------------------------------------------------------------
  -- 1. People with no identity (0040)
  -- ---------------------------------------------------------------------------
  v_count := 0;
  for r in
    select p.uid from public.person p
     where not exists (select 1 from public.identity i where i.uid = p.uid)
  loop
    perform public.identity_sync_person(r.uid);
    v_count := v_count + 1;
  end loop;
  raise notice '0045.1  identities created for people that had none: %', v_count;

  -- ---------------------------------------------------------------------------
  -- 2. Identities whose role disagrees with the teacher rule (0040)
  --
  -- The rule is login_type.is_teacher_type. A row that contradicts it means
  -- either trigger 2 or trigger 3 did not fire - the second being the one that
  -- fires when the STUDIO changes who counts as a teacher, touching no person
  -- row at all.
  -- ---------------------------------------------------------------------------
  v_count := 0;
  for r in
    select p.uid
      from public.person p
      join public.identity i on i.uid = p.uid
      left join public.login_type lt
        on lt.k_login_type = p.k_login_type and lt.k_business = p.k_business
     where p.k_login_type is not null
       and (
         (coalesce(lt.is_teacher_type, false) and i.teacher_id is null)
         or (not coalesce(lt.is_teacher_type, false) and i.student_id is null)
       )
  loop
    perform public.identity_sync_person(r.uid);
    v_count := v_count + 1;
  end loop;
  raise notice '0045.2  identities whose role was re-sorted: %', v_count;

  -- ---------------------------------------------------------------------------
  -- 3. Sessions never projected (0042)
  -- ---------------------------------------------------------------------------
  v_count := 0;
  for r in
    select s.k_period, s.dt_start_utc
      from public.session s
     where not exists (
       select 1 from public.session_link sl
        where sl.k_period = s.k_period and sl.dt_start_utc = s.dt_start_utc
     )
  loop
    perform public.class_session_sync(r.k_period, r.dt_start_utc);
    v_count := v_count + 1;
  end loop;
  raise notice '0045.3  sessions projected that had no link: %', v_count;

  -- ---------------------------------------------------------------------------
  -- 4. Teachers not attached (0042)
  --
  -- Restricted to staff whose identity ALREADY resolves to a teacher. One that
  -- does not is not a gap - it is the ordinary "role not yet known" state, and
  -- attaching anything for it here would be inventing a teacher that identity
  -- has not named.
  -- ---------------------------------------------------------------------------
  v_count := 0;
  for r in
    select ss.k_period, ss.dt_start_utc, ss.k_staff
      from public.session_staff ss
      join public.identity i on i.k_staff = ss.k_staff and i.teacher_id is not null
      join public.session_link sl
        on sl.k_period = ss.k_period and sl.dt_start_utc = ss.dt_start_utc
       and sl.class_session_id is not null
     where not exists (
       select 1 from public.class_session_teacher cst
        where cst.class_session_id = sl.class_session_id
          and cst.teacher_id = i.teacher_id
     )
  loop
    perform public.class_session_sync_teacher(r.k_period, r.dt_start_utc, r.k_staff);
    v_count := v_count + 1;
  end loop;
  raise notice '0045.4  teachers attached to sessions: %', v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Attendance never projected (0044)
--
-- GUARDED, because 0044 may not have been applied yet. A reconcile that fails on
-- a database one migration behind is a reconcile nobody runs when they need it.
--
-- SET-BASED, for the reason 0044 gives: this is the largest table in the design,
-- and a row-by-row loop over a real gap in it is a statement timeout rather than
-- a slow success.
-- -----------------------------------------------------------------------------
do $$
declare
  v_count integer := 0;
begin
  if to_regclass('public.attendance_record') is null then
    raise notice '0045.5  skipped - attendance_record does not exist (0043/0044 not applied)';
    return;
  end if;

  with missing as (
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
     where not exists (
       select 1 from public.attendance_record ar
        where ar.class_session_id = sl.class_session_id
          and ar.student_id = i.student_id
     )
  )
  insert into public.attendance_record (
    class_session_id, student_id,
    is_attended, is_no_show, is_cancelled_client, is_cancelled_studio,
    is_late_cancel, is_waitlisted, booked_at, checked_in_at, cancelled_at
  )
  select class_session_id, student_id,
         is_attended, is_no_show, is_cancelled_client, is_cancelled_studio,
         is_late_cancel, is_waitlisted, dt_booked_utc, dt_checkin_utc, dt_cancelled_utc
    from missing
      on conflict (class_session_id, student_id) do nothing;

  get diagnostics v_count = row_count;
  raise notice '0045.5  attendance records created that were missing: %', v_count;

  -- The link, for any record that now has none. Separate from the insert above
  -- because a record can exist with its link missing - that is exactly the state
  -- a half-finished run leaves, and it reads as "recorded in the portal", which
  -- would be wrong.
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
   where not exists (
     select 1 from public.attendance_link al
      where al.k_period = a.k_period and al.dt_start_utc = a.dt_start_utc
        and al.uid = a.uid
   )
      on conflict (k_period, dt_start_utc, uid) where k_period is not null
      do nothing;

  get diagnostics v_count = row_count;
  raise notice '0045.6  attendance links created that were missing: %', v_count;
end;
$$;
