-- =============================================================================
-- 0040  Fill identity/student/teacher, and keep them filled - by trigger
--
-- 0039 created the tables. They are inert: nothing writes them. This migration
-- makes them true, and keeps them true.
--
-- WHY THE BACKFILL AND THE TRIGGERS ARE IN ONE FILE
--   Split across two migrations, every person inserted between the backfill and
--   the trigger that was meant to catch it is lost - with nothing anywhere to say
--   so. The gap is small and the failure is silent, which is the worst pair. DDL
--   in Postgres is transactional, so both happen or neither does.
--
-- WHY A TRIGGER AND NOT SYNC CODE
--   `person` is upserted from SEVEN modules across sixteen call sites:
--     src/sync/attendance.ts   src/sync/profiles.ts
--     src/sync/clients.ts      src/sync/recipients.ts
--     src/sync/pass.ts (x9)    src/sync/sessions.ts
--     src/sync/writer.ts
--   Filling identity from application code means changing all sixteen, and the
--   first future writer that forgets leaves a silent hole. That is the same
--   failure 0001 cites when it refuses an is_staff flag: two places holding one
--   fact is how they come to disagree.
--
--   A trigger needs zero call-site changes and cannot be forgotten by a writer
--   that does not know it exists. `git diff --stat src/` for this work is empty.
--
-- THE ROLE RULE
--   Teacher iff login_type.is_teacher_type - k_login_type 1260510 on the live
--   business. Everyone else is a student. Confirmed by the studio 24 Aug 2026 and
--   again 17 Sep 2026. It is DATA, not code, which is why trigger 3 below exists.
--
-- STUB PEOPLE GET AN IDENTITY AND NO ROLE
--   src/sync/recipients.ts writes a person stub of {uid, k_business} only, to hold
--   an FK. It has no k_login_type, so its role is not "student" - it is NOT YET
--   KNOWN. Defaulting such a row to student would show a future teacher as a
--   student until enrichment catches up, then need a correcting move.
--
--   So: identity yes, role unset, and trigger 2 fills it when the login type
--   arrives. Unset is countable, which is what the health check (task 1.8) wants
--   to count. Reversing this is a WHERE clause, not a redesign.
--
-- A LOGIN TYPE WE HAVE NOT SYNCED YET STILL RESOLVES
--   If k_login_type is set but login_type has no such row, is_teacher_type reads
--   false and the person becomes a student. That is correct under "everyone else
--   is a student", and trigger 3 promotes them the moment the login-type sync
--   lands the row. The system converges; it does not wait.
--
-- ONE DIRECTION ONLY
--   person -> identity, never back. No trigger here writes to person or to
--   login_type, so there is no loop and one fact keeps one writer.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The whole rule, in one function. Called by the backfill and by all three
-- triggers, so there is exactly one definition of what a person maps to.
-- -----------------------------------------------------------------------------
-- IDEMPOTENT BY CONSTRUCTION. The sync upserts the same person rows continuously,
-- so this runs constantly on unchanged data and must settle to the same result
-- every time. Every write below is an upsert or a guarded update; there is no
-- bare INSERT anywhere in it.
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
  insert into public.identity (uid, k_staff, k_business, ghl_contact_id, synced_at)
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
      insert into public.teacher (first_name, last_name, email, phone)
      values (v_person.first_name, v_person.last_name, v_person.email,
              v_person.phone)
      returning id into v_teacher_id;

      update public.identity
         set teacher_id = v_teacher_id,
             student_id = null
       where id = v_identity_id;
    else
      update public.teacher
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
        update public.identity set student_id = null where id = v_identity_id;
      end if;
    end if;

  else
    if v_student_id is null then
      insert into public.student (first_name, last_name, email, phone,
                                  date_of_birth)
      values (v_person.first_name, v_person.last_name, v_person.email,
              v_person.phone, v_person.date_of_birth)
      returning id into v_student_id;

      update public.identity
         set student_id = v_student_id,
             teacher_id = null
       where id = v_identity_id;
    else
      -- The IS DISTINCT FROM guard is not decoration. Without it this UPDATE fires
      -- on every person on every nightly pass, and student_set_updated_at moves
      -- updated_at on all of them - which makes "what changed recently" answer
      -- "everything, every night" and useless.
      update public.student
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
        update public.identity set teacher_id = null where id = v_identity_id;
      end if;
    end if;
  end if;
end;
$$;

comment on function public.identity_sync_person(text) is
  'The single definition of what a person maps to in identity/student/teacher. '
  'Called by the backfill and by all three triggers so the rule exists once. '
  'Idempotent: no bare INSERT, and every role update is guarded by IS DISTINCT '
  'FROM so an unchanged nightly pass writes nothing.';

-- -----------------------------------------------------------------------------
-- TRIGGER 1  person INSERT -> create the identity
-- -----------------------------------------------------------------------------
create or replace function public.identity_on_person_insert()
returns trigger
language plpgsql
as $$
begin
  perform public.identity_sync_person(new.uid);
  return null;
end;
$$;

drop trigger if exists person_identity_insert on public.person;
create trigger person_identity_insert
  after insert on public.person
  for each row execute function public.identity_on_person_insert();

-- -----------------------------------------------------------------------------
-- TRIGGER 2  person k_login_type CHANGES -> set or move the role
-- -----------------------------------------------------------------------------
-- THE `WHEN` CLAUSE IS NOT OPTIONAL, AND `UPDATE OF` ALONE IS NOT ENOUGH.
--
-- In Postgres, `UPDATE OF col` fires when the column APPEARS IN THE UPDATE
-- STATEMENT, not when its value changes. Every sync upsert writes
-- `k_login_type = excluded.k_login_type`, so `UPDATE OF` alone would fire on all
-- ~1,285 rows every night and do nothing each time.
--
-- IS DISTINCT FROM, not <>: k_login_type is nullable, and `null <> null` is null,
-- which is not true, so a stub finally learning its login type would never fire.
-- That is exactly the case this trigger exists for.
create or replace function public.identity_on_person_login_type_change()
returns trigger
language plpgsql
as $$
begin
  perform public.identity_sync_person(new.uid);
  return null;
end;
$$;

drop trigger if exists person_identity_login_type on public.person;
create trigger person_identity_login_type
  after update of k_login_type on public.person
  for each row
  when (old.k_login_type is distinct from new.k_login_type)
  execute function public.identity_on_person_login_type_change();

-- -----------------------------------------------------------------------------
-- TRIGGER 3  login_type.is_teacher_type CHANGES -> re-sort EVERYONE on that type
-- -----------------------------------------------------------------------------
-- THIS IS THE ONE THAT IS EASY TO MISS ENTIRELY.
--
-- 0014 deliberately made the teacher rule data: "changing who counts as a teacher
-- is an UPDATE here, not a deploy." Flip is_teacher_type onto a different login
-- type and every affected person's role changes with NOT ONE person row touched.
-- A trigger on `person` alone would never fire, and the roles would be wrong with
-- nothing to indicate it.
--
-- Fires on INSERT too: 0014's own seed inserts the row when the login-type sync
-- has not created it yet, and that insert is what decides who is a teacher on a
-- fresh database.
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

-- TWO TRIGGERS, ONE FUNCTION, AND THAT IS NOT A STYLE CHOICE.
--
-- The first draft was a single `after insert or update of` trigger whose WHEN
-- read `tg_op = 'INSERT' or old.is_teacher_type is distinct from new...`.
-- Postgres rejected it in the SQL editor on 17 Sep 2026:
--
--   ERROR: 42703: column "tg_op" does not exist
--
-- TG_OP is a PL/pgSQL variable that exists inside a trigger FUNCTION BODY. A
-- WHEN clause is a plain SQL expression over OLD and NEW and has no such thing.
-- Fixing only that spelling fails again on the next line, because a trigger
-- whose events include INSERT may not reference OLD in its WHEN clause at all:
--
--   ERROR: INSERT trigger's WHEN condition cannot reference OLD values
--
-- So the condition genuinely cannot be written once. The alternative is to move
-- it into the function body, where TG_OP does work - but that means the function
-- is CALLED on every statement naming is_teacher_type and then decides to do
-- nothing, which is the exact cost the WHEN clause on trigger 2 exists to avoid.
-- Two triggers keep the filter where Postgres can apply it without calling
-- anything.
drop trigger if exists login_type_identity_rule on public.login_type;

drop trigger if exists login_type_identity_rule_insert on public.login_type;
create trigger login_type_identity_rule_insert
  after insert on public.login_type
  for each row
  when (pg_trigger_depth() < 2)
  execute function public.identity_on_teacher_rule_change();

drop trigger if exists login_type_identity_rule_update on public.login_type;
create trigger login_type_identity_rule_update
  after update of is_teacher_type on public.login_type
  for each row
  when (
    pg_trigger_depth() < 2
    and old.is_teacher_type is distinct from new.is_teacher_type
  )
  execute function public.identity_on_teacher_rule_change();

-- -----------------------------------------------------------------------------
-- THE BACKFILL. Same file, same transaction, for the reason in the header.
--
-- Ordered by uid only so a re-run is deterministic and a partial failure is
-- reproducible. It calls the same function the triggers call - a backfill written
-- separately is a second definition of the rule, and the two drift.
-- -----------------------------------------------------------------------------
do $$
declare
  v_uid text;
begin
  for v_uid in select uid from public.person order by uid loop
    perform public.identity_sync_person(v_uid);
  end loop;
end;
$$;
