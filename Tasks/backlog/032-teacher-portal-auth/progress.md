# Progress: Teacher sign-in — the same door, a read-only roster behind it

## Checklist

- [ ] Widen `app.identity_for_email()` to either role (new migration)
- [ ] `app.current_teacher_id()`, with the 0053 grant pattern
- [ ] Teacher `for select` policies on the seven tables in task.md
- [ ] Prove additivity: student isolation section C passes unchanged
- [ ] Teacher section in `supabase/checks/portal_auth_isolation.sql`
- [ ] Decide Jared Feldman's address (data fix or RUNBOOK §10a note)
- [ ] `GET /api/v1/me` returning the role from the identity
- [ ] `proxy.ts` guards `/teacher`, no cross-role redirect loop
- [ ] `/auth/verify` picks the destination by role
- [ ] `/teacher` roster page
- [ ] Docs in the same commit: DATA-MODEL, ARCHITECTURE migration table, STATUS

## Last step

Not yet started. Scope and measurement settled 9 Oct 2026.

## Blockers

Gated by task 028's remaining steps: `0054` applied to live, and custom SMTP
with the `{{ .Token }}` template. Until a code actually arrives, teacher sign-in
cannot be verified end to end — the same wall 028 is at.

## Log

### 2026-10-09
- Task created. Scope set by the user: **read-only roster, no writes for now.**
- Measured read-only against live before writing the PRD, as the equivalent of
  028's email measurement:
  - 47 teachers, **all 47 with an email**, no duplicates inside `teacher`, all 47
    already carrying an `identity` row. None has signed in (`auth_user_id` null
    on all 47).
  - **All 47 teacher addresses also sit on an `app.student` row** — and exactly
    47 student rows have no identity. `0040`'s trigger resolved every one of
    these humans to the teacher role and orphaned the duplicate student row, so
    an across-both-roles lookup still returns one identity. No identity holds
    both roles; `identity_one_role_check` is intact.
  - **One exception: Jared Feldman.** His address is on one teacher row and two
    student rows, one of which has its own identity — two identities, so the
    widened function returns NULL and he is refused like a stranger. Recorded as
    a decision in task.md rather than patched around with a tie-break.
- The finding that shaped the scope: the login is the small half. Every policy in
  `0053` resolves "me" through `app.current_student_id()`, so widening only the
  admission test would sign a teacher in to an empty portal — the exact failure
  `/auth/verify` signs people out to avoid.
