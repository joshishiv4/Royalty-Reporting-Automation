-- =============================================================================
-- 0003  make the views respect RLS, and verify what actually landed
--
-- THE PROBLEM. `person` has row level security enabled, but the `client` and
-- `teacher` views over it do not inherit that - a Postgres view runs with the
-- privileges of its OWNER by default, so it reads straight past the policies on
-- the table underneath. Supabase flags this in the table editor as UNRESTRICTED.
--
-- Left alone, RLS on `person` would be decorative: anything with access to the
-- views has unfiltered access to the same rows.
--
-- THE FIX is security_invoker, which makes the view execute as the CALLER, so
-- the policies on `person` apply to anyone selecting from `client` or `teacher`.
-- Available from Postgres 15; Supabase is well past that.
-- =============================================================================

alter view public.client  set (security_invoker = on);
alter view public.teacher set (security_invoker = on);

-- =============================================================================
-- Verification. Reads only - run it and check the three result sets.
-- =============================================================================

-- 1. The views now defer to the caller. Expect security_invoker=on for both.
select c.relname as view_name,
       coalesce(
         (select option_value
          from pg_options_to_table(c.reloptions)
          where option_name = 'security_invoker'),
         'OFF - still unrestricted'
       ) as security_invoker
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('client', 'teacher');

-- 2. Contact fields are sized for phone numbers that arrive already in full
--    international format. Expect phone/phone_home/phone_work = 32 and
--    email = 255. A null length means the column is unbounded varchar, which
--    would NOT satisfy the criterion.
select table_name, column_name, character_maximum_length as max_len
from information_schema.columns
where table_schema = 'public'
  and table_name in ('person', 'lead')
  and column_name in ('email', 'phone', 'phone_home', 'phone_work',
                      'payer_email', 'payer_phone')
order by table_name, column_name;

-- 3. The table-level guard survived. Expect person_staff_fields_need_k_staff -
--    it stops a row claiming teaching flags without a staff id, which would
--    otherwise be a silent data bug rather than an error.
select conname as constraint_name,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.person'::regclass
  and contype = 'c'
order by conname;
