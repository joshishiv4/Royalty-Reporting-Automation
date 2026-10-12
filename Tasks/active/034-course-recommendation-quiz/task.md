---
id: 034
title: Course-recommendation quiz — interest questions → a Claude-suggested course
status: active
priority: high
depends_on: [033]
created: 2026-10-12
---

# Course-recommendation quiz

## Goal

A student answers a short interest quiz; the portal sends their answers plus a
catalogue of teachers and the courses they teach to the Claude API, which suggests
the best-fit course (and its teacher) with a short reason. The attempt and the
suggestion are saved so the student can see it again and retake.

## Decisions (from the user, 12 Oct 2026)

- **Recommender: Claude API (LLM).** Not rule-based. The model is given the
  questions, the student's answers, and the catalogue, and must choose from the
  catalogue only.
- **Catalogue: from the existing database.** No hand-curated course list. It is
  built from the WellnessLiving service catalogue already synced:
  `public.service` (title, category) × `public.staff_service` (teacher↔service) ×
  `public.service_category`, with the teacher's name resolved through
  `app.identity.k_staff` → `app.teacher`. Read **server-side with the service
  role** (a global catalogue read, not a per-user RLS read) — the same trust level
  the sync runs at. The chosen course/teacher are **snapshotted as text** into the
  suggestion row, so the portal never has to read the WL mirror and no FK crosses
  into it.
- **Quiz content: database tables.** Questions and options live in `app` tables so
  they can change without a deploy (and later get an admin UI).
- **Results: saved.** Each attempt stores the answers and the returned suggestion.

## Scope

**Schema (`Royalty-Reporting-Automation`, new migration `0059`)** — `app` tables:
- `quiz_question` — `id`, `prompt`, `sort`, `is_active`, timestamps.
- `quiz_option` — `id`, `question_id` (FK), `label`, `sort`. (An optional
  `category_hint text` to nudge the model is allowed but not required.)
- `quiz_attempt` — `id`, `student_id` (FK → `app.student`), `organization_id`
  (stamped), `created_at`.
- `quiz_answer` — `id`, `attempt_id` (FK, cascade), `question_id`, `option_id`.
- `quiz_suggestion` — `id`, `attempt_id` (FK, cascade, unique), snapshot columns
  `course_title`, `course_category`, `teacher_name`, `rationale text`, and
  `model text` (which Claude model produced it), `created_at`.
- **RLS (first student-written `app` tables):**
  - `quiz_question` / `quiz_option`: SELECT to `authenticated` (everyone signed in
    can read the active quiz).
  - `quiz_attempt` / `quiz_answer` / `quiz_suggestion`: the student owns their own
    — SELECT and INSERT where the row resolves to `app.current_student_id()`.
    Answers/suggestion resolve ownership through their attempt. Suggestion is
    written **server-side (service role)** after the Claude call, so it needs no
    student INSERT policy — mirrors how `teacher_note_revision` is trigger-written.
  - Follow every `0056`–`0058` rule: no policy names a table inline (use
    `app.current_student_id()`), grants before policies, `organization_stamp`
    trigger, trailing self-checks, and a `supabase/checks/` isolation proof
    (student reads only their own attempts; another student reads none; `anon`
    refused), mutation-checked.
- Seed a first set of questions/options in the migration (or a companion seed), so
  the quiz is non-empty on day one.

**Recommender + API (`spin-dj-pathways`)**
- `POST /api/v1/quiz/attempts` (session client, RLS): validates answers, writes
  `quiz_attempt` + `quiz_answer` as the student, then — server-side — builds the
  catalogue (service-role read of the existing tables), calls the Claude API with
  a constrained prompt (choose one course from this list, or say none fits, return
  JSON), writes `quiz_suggestion` (service role), and returns it.
- `GET /api/v1/quiz` — the active questions + options.
- `GET /api/v1/quiz/attempts/me` (or latest) — the student's past attempt(s) +
  suggestion.
- Load the **`claude-api` skill** before writing the Anthropic call; pin an exact,
  current model id and keep the catalogue/answers the only variable input.
  `ANTHROPIC_API_KEY` is server-only env (`.env` / Vercel), never `NEXT_PUBLIC_`.
- Guardrails: the model must pick only from the supplied catalogue (validate its
  choice against the list before saving); a "no good match" path; a failure path
  that still saves the attempt and reports the error without inventing a course.

**UI (`spin-dj-pathways`)**
- A new student tab ("Find your course") + route, in the `NAV_ITEMS`/`TAB_PATH`
  pattern used for Notes.
- Question flow (one or all-on-a-page), submit, loading state while Claude runs,
  then the suggestion card (course, teacher, why) with a Retake action and a view
  of the last result on return.

## Out of scope

- An admin UI to edit questions (DB-editable is enough for v1).
- Booking/enrolling in the suggested course (just the suggestion).
- Teacher-side visibility of a student's quiz result (could be a follow-up; not now).
- Projecting the WL service catalogue into `app` (the recommender reads it
  server-side and snapshots the result; a projection is a larger, separate task).

## Acceptance criteria

- [ ] `0059` creates the five tables with RLS, `organization_stamp`, trailing
      checks; a seed makes the quiz non-empty; `supabase/checks` proof passes and
      is mutation-checked.
- [ ] A student can open the quiz, answer, and get a saved suggestion drawn only
      from real teachers/courses in the database.
- [ ] The suggested course/teacher always exists in the catalogue sent to the
      model (no invented courses); a "no match" and an API-failure path are handled.
- [ ] The attempt + answers + suggestion are stored and readable by that student
      only (RLS proven); another student and `anon` read nothing.
- [ ] `ANTHROPIC_API_KEY` is server-only; the Claude call runs in a route handler,
      never the browser.
- [ ] Portal `next build` green; DATA-MODEL.md + ARCHITECTURE.md updated in the
      same commit as `0059`.

## Constraints & notes

- Catalogue read is the one place this feature touches the WL mirror, and only via
  the service role on the server — consistent with the sync, not with the portal's
  RLS reads. Confirm the exact join first (`staff_service` has `k_staff`/`k_service`;
  `service` has `s_service`/`k_service_category`; teacher name via
  `identity.k_staff` → `app.teacher`). Skip services where `is_bookable`/`is_resolved`
  say they are not real offerings.
- If the catalogue turns out too thin or messy to recommend from, fall back to
  `app.cohort` (+ its teachers) as the course list — a swap of the catalogue
  builder only, nothing else changes.
- Decide the model with the `claude-api` skill at implementation (a small
  classification/selection task — likely Haiku or Sonnet); record it in
  `quiz_suggestion.model`.

## Resources

- `resources/` — add the applied-migration output and any prompt drafts here.
