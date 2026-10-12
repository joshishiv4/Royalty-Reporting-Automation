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
- [ ] Apply `0059` in the SQL editor; run `quiz_isolation.sql`
- [ ] Put a real `ANTHROPIC_API_KEY` in `.env` / Vercel and run end-to-end

## Last step
*One line summary of where work paused.*

Feature built end-to-end and portal `next build` is green. Blocked only on (1) applying `0059` in the SQL editor and (2) a real ANTHROPIC_API_KEY in the environment, after which it can be exercised live.

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
