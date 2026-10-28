-- =============================================================================
-- 0059  Course-recommendation quiz
--
-- WHAT THIS ADDS
--   Five app tables for an interest quiz whose result is a Claude-suggested course:
--     quiz_question   - the questions (studio config)
--     quiz_option     - the answers to choose from
--     quiz_attempt    - one student taking the quiz
--     quiz_answer     - the options that student chose
--     quiz_suggestion - the course the model picked, snapshotted as text
--
-- HOW THE WRITE PATH WORKS, AND WHY THERE IS NO STUDENT INSERT POLICY
--   The attempt, its answers and the suggestion are all written SERVER-SIDE with
--   the service role, by the route that also builds the catalogue and calls Claude.
--   The student's id is NOT taken from the request - it is resolved from the
--   caller's own JWT through the session client first, then used for the writes.
--   That is the distinction STATUS.md draws for the uploads route: trusting a
--   caller-supplied id is the hole; deriving the id from the verified session is
--   not. So these tables grant `authenticated` SELECT only, and a student cannot
--   forge an attempt, an answer, or a suggestion - the same shape as
--   teacher_note_revision (0057), one step wider.
--
-- READS ARE RLS, STUDENT-OWNS-OWN. student_id is denormalised onto quiz_answer and
-- quiz_suggestion so the read policy is a plain column comparison and never joins
-- quiz_attempt (the 42P17 rule from 0055). quiz_question/quiz_option are readable
-- by any signed-in user - they are the quiz, not anyone's data.
--
-- THE CATALOGUE IS NOT HERE. The teachers/courses the model chooses from are read
-- at request time from the existing WL service catalogue (service, staff_service,
-- service_category) by the server, and the chosen course is snapshotted into
-- quiz_suggestion as text. Nothing in this migration references the mirror, and no
-- FK crosses into it - see task 034.
--
-- Depends on 0048 (organization_stamp) and 0053 (current_student_id). Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- quiz_question / quiz_option - the quiz itself
-- -----------------------------------------------------------------------------
create table if not exists app.quiz_question (
  id              uuid        primary key default gen_random_uuid(),
  -- A stable handle for seeding and for code to reference without embedding a
  -- uuid (which differs per environment) - the same reason organization has slug.
  code            text        not null,
  prompt          text        not null,
  sort            integer     not null default 0,
  is_active       boolean     not null default true,
  -- Whether a free-text box is shown for this question, in ADDITION to any
  -- options. A question may have options only, a text box only (no option rows),
  -- or both - the three combinations the quiz UI supports.
  allow_text      boolean     not null default false,
  organization_id uuid        not null references app.organization (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint quiz_question_code_unique unique (code)
);

comment on table app.quiz_question is
  'An interest-quiz question (studio config). Readable by any signed-in user; '
  'written by the studio / service role. See 0059.';

create table if not exists app.quiz_option (
  id          uuid        primary key default gen_random_uuid(),
  code        text        not null,
  question_id uuid        not null references app.quiz_question (id) on delete cascade,
  label       text        not null,
  -- An optional nudge for the model (e.g. 'piano', 'production'); not required and
  -- not shown to the student.
  category_hint text,
  sort        integer     not null default 0,
  created_at  timestamptz not null default now(),
  constraint quiz_option_code_unique unique (code)
);

comment on table app.quiz_option is
  'A selectable answer for a quiz_question. No organization_id - its question''s.';

create index if not exists quiz_option_question_idx
  on app.quiz_option (question_id, sort);

-- -----------------------------------------------------------------------------
-- quiz_attempt / quiz_answer / quiz_suggestion - one student's run
-- -----------------------------------------------------------------------------
create table if not exists app.quiz_attempt (
  id              uuid        primary key default gen_random_uuid(),
  student_id      uuid        not null references app.student (id) on delete restrict,
  organization_id uuid        not null references app.organization (id) on delete restrict,
  -- Short interest tags the model inferred from this attempt's answers (including
  -- the free-text). Filled by the server after the LLM call; shown on the home
  -- "Things I'm Into" card.
  interests       text[],
  created_at      timestamptz not null default now()
);

comment on table app.quiz_attempt is
  'One student taking the quiz. Written server-side with the student id resolved '
  'from the caller''s JWT, read by that student only. See 0059.';

create index if not exists quiz_attempt_student_idx
  on app.quiz_attempt (student_id, created_at desc);

create table if not exists app.quiz_answer (
  id          uuid        primary key default gen_random_uuid(),
  attempt_id  uuid        not null references app.quiz_attempt (id) on delete cascade,
  question_id uuid        not null references app.quiz_question (id) on delete restrict,
  -- NULLABLE: a free-text answer has no chosen option. A both-kind question keeps
  -- the option here and the typed note in answer_text.
  option_id   uuid        references app.quiz_option (id) on delete restrict,
  answer_text text,
  -- Denormalised from the attempt so the read policy joins nothing (the 42P17
  -- rule). The attempt's student never changes, so it cannot fall out of step.
  student_id  uuid        not null references app.student (id) on delete restrict,
  created_at  timestamptz not null default now(),
  -- An answer is not empty: it carries a chosen option, some typed text, or both.
  constraint quiz_answer_has_content
    check (option_id is not null or (answer_text is not null and length(btrim(answer_text)) > 0)),
  -- One answer per question per attempt.
  constraint quiz_answer_attempt_question_unique unique (attempt_id, question_id)
);

create index if not exists quiz_answer_attempt_idx
  on app.quiz_answer (attempt_id);

create table if not exists app.quiz_suggestion (
  id              uuid        primary key default gen_random_uuid(),
  attempt_id      uuid        not null references app.quiz_attempt (id) on delete cascade,
  student_id      uuid        not null references app.student (id) on delete restrict,
  -- Snapshotted as TEXT, not a FK into the WL mirror - the portal must never read
  -- the mirror, and a course name as it was recommended is the fact to keep.
  course_title    text        not null,
  course_category text,
  teacher_name    text,
  rationale       text        not null,
  -- Which Claude model produced this, for the record.
  model           text        not null,
  -- 1 = best fit. An attempt gets up to three ranked suggestions.
  rank            integer     not null default 1,
  created_at      timestamptz not null default now(),
  -- One row per rank per attempt (at most one #1, one #2, one #3).
  constraint quiz_suggestion_attempt_rank_unique unique (attempt_id, rank)
);

comment on table app.quiz_suggestion is
  'The course the model suggested for an attempt, snapshotted as text. Written by '
  'the service role after the Claude call; read by the attempt''s student only.';

-- -----------------------------------------------------------------------------
-- Reconcile an already-applied earlier version of this migration
-- -----------------------------------------------------------------------------
-- `create table if not exists` skips an existing table, so columns and
-- constraints added to this file after it was first applied need explicit,
-- idempotent ALTERs. On a fresh database these are all no-ops (the columns
-- already exist with these shapes); on a database that ran an earlier 0059 they
-- bring it up to date - so re-running 0059 is enough, no hand-written ALTER.
alter table app.quiz_question   add column if not exists allow_text boolean not null default false;
alter table app.quiz_answer     add column if not exists answer_text text;
alter table app.quiz_answer     alter column option_id drop not null;
alter table app.quiz_suggestion add column if not exists rank integer not null default 1;
alter table app.quiz_attempt    add column if not exists interests text[];

do $$
begin
  -- quiz_answer must allow an option, text, or both.
  if not exists (
    select 1 from pg_constraint
    where conname = 'quiz_answer_has_content' and conrelid = 'app.quiz_answer'::regclass
  ) then
    alter table app.quiz_answer add constraint quiz_answer_has_content
      check (option_id is not null or (answer_text is not null and length(btrim(answer_text)) > 0));
  end if;

  -- quiz_suggestion moved from one-per-attempt to one-per-rank.
  if exists (
    select 1 from pg_constraint
    where conname = 'quiz_suggestion_attempt_unique' and conrelid = 'app.quiz_suggestion'::regclass
  ) then
    alter table app.quiz_suggestion drop constraint quiz_suggestion_attempt_unique;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'quiz_suggestion_attempt_rank_unique' and conrelid = 'app.quiz_suggestion'::regclass
  ) then
    alter table app.quiz_suggestion add constraint quiz_suggestion_attempt_rank_unique unique (attempt_id, rank);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Triggers: organization stamp (the two root tables) and updated_at
-- -----------------------------------------------------------------------------
drop trigger if exists quiz_question_organization_stamp on app.quiz_question;
create trigger quiz_question_organization_stamp
  before insert on app.quiz_question
  for each row execute function public.organization_stamp();

drop trigger if exists quiz_question_set_updated_at on app.quiz_question;
create trigger quiz_question_set_updated_at
  before update on app.quiz_question
  for each row execute function public.set_updated_at();

drop trigger if exists quiz_attempt_organization_stamp on app.quiz_attempt;
create trigger quiz_attempt_organization_stamp
  before insert on app.quiz_attempt
  for each row execute function public.organization_stamp();

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table app.quiz_question   enable row level security;
alter table app.quiz_option     enable row level security;
alter table app.quiz_attempt    enable row level security;
alter table app.quiz_answer     enable row level security;
alter table app.quiz_suggestion enable row level security;

-- Grants. authenticated reads everything it is allowed to SEE (policies narrow it);
-- it WRITES nothing here - attempts, answers and suggestions are service-role
-- writes with a session-resolved student id. service_role keeps full access.
grant select on app.quiz_question   to authenticated;
grant select on app.quiz_option     to authenticated;
grant select on app.quiz_attempt    to authenticated;
grant select on app.quiz_answer     to authenticated;
grant select on app.quiz_suggestion to authenticated;

grant select, insert, update, delete on app.quiz_question   to service_role;
grant select, insert, update, delete on app.quiz_option     to service_role;
grant select, insert, update, delete on app.quiz_attempt    to service_role;
grant select, insert, update, delete on app.quiz_answer     to service_role;
grant select, insert, update, delete on app.quiz_suggestion to service_role;

-- The quiz is readable by anyone signed in. Only active questions.
drop policy if exists quiz_question_read on app.quiz_question;
create policy quiz_question_read on app.quiz_question
  for select to authenticated
  using (quiz_question.is_active);

drop policy if exists quiz_option_read on app.quiz_option;
create policy quiz_option_read on app.quiz_option
  for select to authenticated
  using (true);

-- A student reads only their own attempts, answers and suggestions.
-- current_student_id() is NULL for a teacher / unlinked human, and NULL compared
-- with `=` is NULL, never true - so nobody else reads a row. No `is null` here,
-- the 0055 rule.
drop policy if exists quiz_attempt_self_select on app.quiz_attempt;
create policy quiz_attempt_self_select on app.quiz_attempt
  for select to authenticated
  using (quiz_attempt.student_id = app.current_student_id());

drop policy if exists quiz_answer_self_select on app.quiz_answer;
create policy quiz_answer_self_select on app.quiz_answer
  for select to authenticated
  using (quiz_answer.student_id = app.current_student_id());

drop policy if exists quiz_suggestion_self_select on app.quiz_suggestion;
create policy quiz_suggestion_self_select on app.quiz_suggestion
  for select to authenticated
  using (quiz_suggestion.student_id = app.current_student_id());

-- =============================================================================
-- Seed: a first question set, so the quiz is non-empty on day one
-- =============================================================================
-- Keyed on `code`, so re-running does not duplicate. Categories in category_hint
-- are nudges for the model, not shown to the student and not a schema of record.
-- General interest-finding questions. They ask about what the student is drawn
-- to rather than naming courses; the category_hint on each option is the quiet
-- mapping the recommender uses, and is never shown to the student.
insert into app.quiz_question (code, prompt, sort, allow_text) values
  ('genre',    'What kind of music are you most into?',            1, false),
  ('grabs',    'When you hear a song you love, what grabs you first?', 2, false),
  ('spend',    'How do you most enjoy spending time with music?',  3, false),
  -- Both: a general interest pick AND room to say more in their own words.
  ('proud',    'What would you be proudest to make or do?',        4, true),
  ('experience','How much have you played or made music before?',  5, false),
  -- Text only: no options, just a free-text box.
  ('anything', 'Anything else about what you''re into?',           6, true)
on conflict (code) do nothing;

insert into app.quiz_option (code, question_id, label, category_hint, sort)
select v.code, q.id, v.label, v.hint, v.sort
from app.quiz_question q
join (values
  ('genre',      'genre_hiphop', 'Hip-hop and rap',                   'production', 1),
  ('genre',      'genre_edm',    'Electronic and dance',              'dj',         2),
  ('genre',      'genre_pop',    'Pop and R&B',                       'voice',      3),
  ('genre',      'genre_live',   'Rock, jazz or live bands',          'live sound', 4),
  ('grabs',      'grabs_beat',   'The beat and the rhythm',           'production', 1),
  ('grabs',      'grabs_vocals', 'The vocals',                        'voice',      2),
  ('grabs',      'grabs_melody', 'The melody and instruments',        'piano',      3),
  ('grabs',      'grabs_energy', 'The energy of the crowd',           'live sound', 4),
  ('spend',      'spend_computer','Making things on a computer',      'production', 1),
  ('spend',      'spend_perform','Performing for people',             'live sound', 2),
  ('spend',      'spend_sing',   'Singing along',                     'voice',      3),
  ('spend',      'spend_play',   'Playing an instrument',             'piano',      4),
  ('proud',      'proud_track',  'A track people dance to',           'dj',         1),
  ('proud',      'proud_song',   'A song I wrote and sang',           'voice',      2),
  ('proud',      'proud_show',   'A great live performance',          'live sound', 3),
  ('proud',      'proud_play',   'Playing a piece beautifully',       'piano',      4),
  ('experience', 'exp_none',     'Just starting out',                 null,         1),
  ('experience', 'exp_some',     'A little',                          null,         2),
  ('experience', 'exp_lots',     'Quite a bit',                       null,         3)
) as v(qcode, code, label, hint, sort) on v.qcode = q.code
on conflict (code) do nothing;

-- =============================================================================
-- Trailing checks
-- =============================================================================
do $$
declare
  v_count int;
begin
  -- All five tables exist with RLS enabled.
  select count(*) into v_count
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app'
    and c.relname in ('quiz_question','quiz_option','quiz_attempt','quiz_answer','quiz_suggestion')
    and c.relrowsecurity;
  if v_count <> 5 then
    raise exception 'FAIL: expected 5 quiz tables with RLS, found %', v_count;
  end if;
  raise notice 'OK: five quiz tables with RLS';

  -- The five read policies exist and are all SELECT.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app'
    and tablename in ('quiz_question','quiz_option','quiz_attempt','quiz_answer','quiz_suggestion')
    and cmd = 'SELECT';
  if v_count <> 5 then
    raise exception 'FAIL: expected 5 SELECT policies, found %', v_count;
  end if;
  raise notice 'OK: five SELECT policies';

  -- No non-SELECT policy slipped in (a student write policy would be a mistake -
  -- writes are service-role only here).
  select count(*) into v_count
  from pg_policies
  where schemaname = 'app'
    and tablename in ('quiz_question','quiz_option','quiz_attempt','quiz_answer','quiz_suggestion')
    and cmd <> 'SELECT';
  if v_count <> 0 then
    raise exception 'FAIL: % non-SELECT quiz policy - writes must be service-role only', v_count;
  end if;
  raise notice 'OK: quiz policies are SELECT only';

  -- authenticated must hold no write privilege on the student-data tables.
  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'app'
    and table_name in ('quiz_attempt','quiz_answer','quiz_suggestion')
    and grantee = 'authenticated'
    and privilege_type in ('INSERT','UPDATE','DELETE');
  if v_count <> 0 then
    raise exception 'FAIL: authenticated holds % write privilege(s) on quiz attempt/answer/suggestion', v_count;
  end if;
  raise notice 'OK: authenticated cannot write attempts/answers/suggestions';

  -- The seed landed.
  select count(*) into v_count from app.quiz_question where is_active;
  if v_count < 1 then
    raise exception 'FAIL: no active quiz questions after seed';
  end if;
  raise notice 'OK: % active quiz question(s) seeded', v_count;
end $$;
