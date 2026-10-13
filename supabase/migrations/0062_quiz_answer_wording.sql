-- =============================================================================
-- 0062  app.quiz_answer: keep the wording the student actually saw
--
-- THE PROBLEM
--   A saved answer was two pointers - `question_id` and `option_id` - and the
--   wording lived only on the question and option rows. So rewording a question in
--   place silently rewrote what every OLD answer to it appeared to say, and there
--   was no way to recover what the student had really been asked. That happened on
--   13 Oct 2026: three questions (`genre`, `experience`, `anything`) were reworded
--   while 13 saved attempts had answered all three.
--
-- THE FIX
--   Copy the wording onto the answer when it is saved, as text. The answer is then
--   a record of what was asked and chosen that does not depend on the question
--   rows staying as they were. This is the same decision `quiz_suggestion` already
--   makes for a recommended course ("a course name as it was recommended is the
--   fact to keep"), applied to the other half of the attempt.
--
--     question_prompt  the question text as shown. NOT NULL: an answer always
--                      belongs to a question.
--     option_label     the chosen option's text. NULL exactly when no option was
--                      chosen (a text-only answer), enforced by a CHECK.
--
--   `answer_text` (what the student typed) is unchanged - it was always their own
--   words, never a pointer.
--
-- WHAT IT DOES NOT CHANGE
--   The `question_id` / `option_id` foreign keys stay, and stay ON DELETE RESTRICT.
--   The pointers say WHICH row was answered; the new columns say WHAT it said at
--   the time. Both are kept, and the question rows are still not to be deleted.
--
-- THE BACKFILL, AND ITS ONE LIMIT
--   Existing answers are filled in from the rows as they stand, except the three
--   questions reworded on 13 Oct 2026: those get the wording from the snapshot
--   taken just before the reword
--   (Tasks/active/034-course-recommendation-quiz/resources/quiz-content-before-
--   2026-10-13.json). Every one of the 13 attempts predates that reword (the last
--   was 06:34 UTC, the snapshot 06:46), so the cutoff below holds for all of them.
--
--   THE LIMIT: that snapshot is the wording live just BEFORE the reword, and it is
--   not necessarily what the very first attempts saw. `0059` seeded different text
--   for `experience` and `anything`, and the live rows were edited by hand at an
--   unrecorded moment afterwards. If an early attempt (12 Oct) preceded that hand
--   edit, its stored wording here is the later one. Nothing in the database can
--   say; this is the best that is knowable, and from now on the record is exact.
--
-- Run BEFORE deploying the portal change that writes these columns: the new
-- submit route inserts them, and fails if they do not exist yet.
--
-- Depends on 0059. Safe to re-run.
-- =============================================================================

alter table app.quiz_answer add column if not exists question_prompt text;
alter table app.quiz_answer add column if not exists option_label    text;

comment on column app.quiz_answer.question_prompt is
  'The question text exactly as the student saw it, copied when the answer was '
  'saved. The question row may be reworded later; this does not follow it. See 0062.';
comment on column app.quiz_answer.option_label is
  'The chosen option''s text as the student saw it, or NULL when no option was '
  'chosen. Copied at save time for the same reason as question_prompt.';

-- -----------------------------------------------------------------------------
-- Backfill. Only rows not yet filled, so a re-run changes nothing.
-- -----------------------------------------------------------------------------
-- 1. The three questions reworded in place on 13 Oct 2026: the pre-reword wording.
update app.quiz_answer a
   set question_prompt = case q.code
         when 'genre'      then 'What kind of music are you most into?'
         when 'experience' then 'How much have you done before?'
         when 'anything'   then 'Anything else you''d like us to know?'
       end
  from app.quiz_question q
 where q.id = a.question_id
   and a.question_prompt is null
   and q.code in ('genre', 'experience', 'anything')
   and a.created_at < timestamptz '2026-10-13 06:46:05+00';

-- 2. Everything else was never reworded, so the row as it stands is what was shown.
update app.quiz_answer a
   set question_prompt = q.prompt
  from app.quiz_question q
 where q.id = a.question_id
   and a.question_prompt is null;

-- No option label was ever changed (only added), so the current label is the one shown.
update app.quiz_answer a
   set option_label = o.label
  from app.quiz_option o
 where o.id = a.option_id
   and a.option_label is null;

-- -----------------------------------------------------------------------------
-- Make it a rule rather than a habit
-- -----------------------------------------------------------------------------
-- Refuse to tighten a column the backfill did not fully fill, and say why, instead
-- of leaving ALTER ... SET NOT NULL to fail with a bare message.
do $$
declare
  v_missing int;
begin
  select count(*) into v_missing from app.quiz_answer where question_prompt is null;
  if v_missing <> 0 then
    raise exception '0062: % quiz_answer row(s) still have no question_prompt after the backfill', v_missing;
  end if;
end $$;

alter table app.quiz_answer alter column question_prompt set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quiz_answer_prompt_not_blank' and conrelid = 'app.quiz_answer'::regclass
  ) then
    alter table app.quiz_answer add constraint quiz_answer_prompt_not_blank
      check (length(btrim(question_prompt)) > 0);
  end if;

  -- A chosen option always has its wording saved. (A text-only answer has neither.)
  if not exists (
    select 1 from pg_constraint
    where conname = 'quiz_answer_option_label_check' and conrelid = 'app.quiz_answer'::regclass
  ) then
    alter table app.quiz_answer add constraint quiz_answer_option_label_check
      check (option_id is null or (option_label is not null and length(btrim(option_label)) > 0));
  end if;
end $$;

-- =============================================================================
-- Trailing checks
-- =============================================================================
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'app' and table_name = 'quiz_answer'
    and column_name in ('question_prompt', 'option_label');
  if v_count <> 2 then
    raise exception 'FAIL: expected question_prompt and option_label on quiz_answer, found %', v_count;
  end if;
  raise notice 'OK: both wording columns present';

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'app' and table_name = 'quiz_answer'
    and column_name = 'question_prompt' and is_nullable = 'NO';
  if v_count <> 1 then
    raise exception 'FAIL: question_prompt must be NOT NULL';
  end if;
  raise notice 'OK: question_prompt is NOT NULL';

  select count(*) into v_count from app.quiz_answer where option_id is not null and option_label is null;
  if v_count <> 0 then
    raise exception 'FAIL: % answer(s) chose an option but saved no option_label', v_count;
  end if;
  raise notice 'OK: every chosen option has its wording saved';

  select count(*) into v_count
  from pg_constraint
  where conrelid = 'app.quiz_answer'::regclass
    and conname in ('quiz_answer_prompt_not_blank', 'quiz_answer_option_label_check');
  if v_count <> 2 then
    raise exception 'FAIL: expected the 2 wording constraints, found %', v_count;
  end if;
  raise notice 'OK: wording constraints present';
end $$;
