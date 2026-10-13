# Progress: Course-recommendation quiz

## Checklist

- [x] Confirm the catalogue join (service × staff_service × service_category, teacher via person.k_staff); exclude unresolved/untitled services
- [x] `0059`: quiz_question, quiz_option, quiz_attempt, quiz_answer, quiz_suggestion + RLS + organization_stamp + trailing checks
- [x] Seed an initial question set (4 questions)
- [x] `supabase/checks/quiz_isolation.sql` — student-owns-own proof, mutation notes
- [x] DATA-MODEL.md + ARCHITECTURE.md updated (same change as `0059`); docs-current passes
- [x] Portal: `GET /api/v1/quiz`, `POST /api/v1/quiz/attempts` (create+recommend), `GET /api/v1/quiz/attempts` (latest)
- [x] Recommender (`app/lib/quiz-recommender.ts`): catalogue builder (service role, public schema) + Claude API (`claude-opus-5-5`) constrained to the catalogue + hallucination/no-match/API-failure guards
- [x] Portal UI: "Find your course" tab + `/student/quiz` (question flow, loading, suggestion card, retake)
- [x] `ANTHROPIC_API_KEY` added to `.env.example` (server-only); portal `next build` green
- [x] Client Q&A workbook: `resources/quiz-questions-template.xlsx` (9 starter questions, one row per answer option, free-text column) — awaiting the client's edits
- [ ] Import the client's returned workbook into the quiz tables (seed or small script) — rules in the log below
- [ ] Apply `0059` in the SQL editor; run `quiz_isolation.sql`
- [ ] Put a real `ANTHROPIC_API_KEY` in `.env` / Vercel and run end-to-end

## Last step
*One line summary of where work paused.*

Feature built end-to-end; portal `next build` green. Catalogue switched to the
portal's own cohort data (see log) after the WL staff_service table was found empty,
and the recommender is provider-switchable (Gemini or Claude by env). Blocked only
on applying `0059` and setting an API key.

## Blockers

None blocking design. At implementation: needs an `ANTHROPIC_API_KEY`, and a confirmation that the WL service catalogue is rich enough to recommend from (else fall back to cohorts).

## Log

### 2026-10-12
- Task created from the user's request: an interest quiz that suggests a course via
  the Claude API, using existing teachers/courses.
- Investigated: no course/quiz/interest entity exists. Catalogue material is the WL
  mirror — `public.service`, `public.service_category`, `public.staff_service` —
  with teacher names bridged through `app.identity.k_staff` → `app.teacher`. The
  portal is specified to read only `app`, so the recommender reads the catalogue
  server-side with the service role and snapshots the chosen course/teacher into
  `app.quiz_suggestion` (no mirror read from the portal, no cross-schema FK).
- Four decisions captured in task.md. PRD ready for confirmation.
- Built: `0059` (schema + RLS + seed + checks), `quiz_isolation.sql`, portal routes,
  recommender, "Find your course" tab. Top-3 ranked suggestions; general
  interest-finding questions.
- Added a **Gemini** path: provider chosen by env (`GEMINI_API_KEY` → Gemini
  `gemini-2.0-flash`/`GEMINI_MODEL`; else Claude). `.env.example` documents both;
  the model used is stored on each suggestion.
- **"No match" on dev — diagnosed:** `public.staff_service` has **0 rows** here
  (123 services / 12 resolved / 20 staff, but no teacher↔service links), so the
  WL-based catalogue was empty. Switched `buildCatalogue()` to the portal's own
  data: `app.cohort` (5 courses) × teachers via `class_session_teacher` →
  `app.teacher` (41,314 links / 48 teachers). Catalogue now non-empty with real
  teacher↔course pairs. **Catalogue tables are now** `app.cohort`,
  `app.class_session`, `app.class_session_teacher`, `app.teacher`. Docs updated.

### 2026-10-13
- Created the client-editable questions workbook,
  `resources/quiz-questions-template.xlsx`: sheets *How to edit*, *Questions*,
  *Categories*. Layout is one row per answer option, columns Q # · Question ·
  Answer option · Category hint · Active · Free-text box. 9 starter questions
  (8 with answers, Q4 answers + free-text, Q9 text-only), written as examples for
  the client to replace. Checked against the real `0059`, which added a column the
  PRD did not have: `quiz_question.allow_text`, hence the Free-text column.
- **Import rules (not yet written):** `code` is generated from Q # (question) and
  Q # + row (option); `sort` from Q # and row order; `category_hint` lowercased to
  match the `0059` vocabulary (`dj`, `piano`, `voice`, `live sound`, `production`);
  `quiz_option` has no active flag, so an Active = N option row is skipped and a
  question whose rows are all N becomes `is_active = false`; a row with a blank
  answer and Free-text = Y is a text-only question (no option rows).
- **Open:** the Categories list (DJ, Piano, Voice, Music Production, Live Sound,
  Podcasting, Video) is a starting list for the client to confirm. The catalogue is
  now the 5 `app.cohort` courses, so the hints are only a nudge to the model and
  need not match course titles.
- Built with `exceljs` (no Python on this machine), installed in the session
  scratchpad only; no project files or dependencies changed.
- **Reviewed the live quiz content (read-only).** Findings: (1) live has 9
  questions, `0059` seeded 6; `goal`, `format` and `interest` appear in no
  migration (added by hand) and two prompts were reworded, so migrations no longer
  reproduce the database; (2) `sort` collides (1,1,2,2,3,3,4,4,5) and the API orders
  by `sort` only, so question order is undefined; (3) `goal`, `interest`, `proud`,
  `spend`, `grabs` all ask the same "perform / make tracks / sing / play" question;
  (4) nothing leads to Podcasting, Media or Video Production (3 of 16 courses);
  (5) `goal` has no DJ option; (6) `format` asks learning style, but the catalogue
  splits Private / Group / For Everyone, which nothing asks; (7) some hints are
  weak (hip-hop -> production, "understand how music works" -> piano);
  (8) `experience` was reworded to "How much have you done before?", which is
  ambiguous. **Nothing in the database was changed.**
- Catalogue (`app.course_catalogue`, `0061`) is 16 distinct courses, 78
  course-teacher rows.
- Created the client-facing Google Doc "Course Finder Quiz - Questions & Answers
  (for client review)" in the user's Drive (private, not shared): 7 revised
  questions (cleaned-up version of the live set, not a copy), reference list of the
  16 courses, 3 questions for the client (Institutional courses, age, missing
  courses). Doc id `15kJPSgEcWrG3N18NQ5d7Gac5YdmldRhDIsMT64ikLJo`.
- **Updated the live quiz content to the revised 7-question set** (service-role
  writes through PostgREST, no migration). Before the change: 9 questions, 13
  attempts / 117 answers / 3 suggestions saved. Done without deleting anything:
  added questions `try` and `setting` and 11 options (DJ and podcast/video goals,
  media genre, equipment, one-on-one vs group); re-ordered with unique sorts
  (goal 1, genre 2, grabs 3, try 4, setting 5, experience 6, anything 7); reworded
  `genre`, `experience`, `anything`; blanked the weak hip-hop and pop hints;
  **deactivated** `proud`, `spend`, `interest`, `format` (sort 101-104) because saved
  answers reference them, and `quiz_question_read` hides inactive questions from
  students. No option labels changed. Attempt/answer/suggestion counts unchanged.
- Snapshot of the content before the change:
  `resources/quiz-content-before-2026-10-13.json`. To reverse: reactivate the four
  retired questions, set the old sort/prompt values back from the snapshot, and
  delete the `try` / `setting` questions and the 11 new options (codes `goal_dj`,
  `goal_media`, `genre_media`, `try_*`, `setting_*`).
- **Still open:** the migrations do not reproduce the database. `0059` seeds the old
  6 questions; `goal`, `format`, `interest` (hand-added earlier) and now `try` /
  `setting` are in no migration. A re-runnable migration setting this state would
  close that. One label differs from the client Doc: `goal_sing` reads "Sing / use
  my voice" (Doc: "Sing and use my voice").
- **Answers now keep the wording the student saw (`0062`).** Found that a saved
  answer was only `question_id` + `option_id`, so the three in-place rewordings above
  rewrote what the 13 existing attempts appeared to say (the original wording only
  survives in the snapshot file). `0062` adds `quiz_answer.question_prompt` (NOT
  NULL) and `option_label` (CHECK: a chosen option always has its label), backfills
  the existing answers, and the submit route now writes both. Replayed the backfill
  rules read-only against the live data: all 117 answers get a prompt (39 take the
  pre-reword wording for genre/experience/anything, 78 the current one), all 104
  option answers get a label, none left empty. Limit recorded in the migration: the
  snapshot wording is what was live just before the reword, not necessarily what the
  very first attempts saw. `quiz_isolation.sql` updated (its answer inserts supply
  the wording) with a new section F that tries the two refusals; docs updated;
  docs-current passes; portal `next build` green. **Not yet applied** — and the
  portal route change is already in the working tree, so quiz submissions fail
  with a missing-column error until `0062` is applied in the SQL editor.
- Rule to keep: a question that has answers is retired and replaced, not reworded.
