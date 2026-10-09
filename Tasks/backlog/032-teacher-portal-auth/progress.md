# Progress: Teacher sign-in — the same door, a read-only roster behind it

## Checklist

- [x] Widen `app.identity_for_email()` to either role - `0055`, written 9 Oct 2026
- [x] `app.current_teacher_id()`, with the 0053 grant pattern - `0055`
- [x] Teacher `for select` policies - SIX, not seven: `identity` needed none
- [x] Three definer reachability helpers, after inline subqueries caused 42P17
- [ ] **Re-run the amended `0055`** - live still carries the recursive version
- [ ] Run `portal_auth_isolation.sql` whole: A-F unchanged, G green
- [ ] Prove additivity: student isolation section C passes unchanged
- [x] Teacher section in `supabase/checks/portal_auth_isolation.sql` - section G
- [ ] Decide Jared Feldman's address (data fix or RUNBOOK §10a note)
- [ ] `GET /api/v1/me` returning the role from the identity
- [ ] `proxy.ts` guards `/teacher`, no cross-role redirect loop
- [ ] `/auth/verify` picks the destination by role
- [ ] `/teacher` roster page
- [x] Docs: DATA-MODEL and the ARCHITECTURE migration table (STATUS when 0055 is applied)

## Last step

`0055` was applied, raised 42P17, and has been AMENDED IN PLACE. It must be
re-run in the SQL editor - until it is, live carries the recursive policies and
a student read can fail. Then run the check file whole.

## Blockers

**Cleared 9 Oct 2026.** `0054` is applied and SMTP is configured; a student has
signed in end to end. Teacher sign-in is no longer gated by 028 — only by its
own work.

One open item inherited from 028, and it belongs *before* `0055` is applied:
confirm against the live catalog that no write policy exists on the `app`
tables. Nothing in `0053` or `0054` grants a write, but it has never been
checked, and `0055` adds six more policies to the surface that claim covers.

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

### 2026-10-09 — `0055` written; the database half is done, unapplied

`supabase/migrations/0055_teacher_portal_auth.sql`, plus section G of
`portal_auth_isolation.sql`, plus DATA-MODEL and the ARCHITECTURE migration
table in the same commit.

**Six policies, not the seven the PRD listed.** `app.identity` needed none:
`0053`'s `identity_self_select` is `auth_user_id = auth.uid()` and never
mentioned a role, so it already answers for a teacher. A teacher-shaped copy
would have been a second definition of "my own row" to keep in step with the
first. No new grants either — `0053` already granted SELECT on all ten tables to
`authenticated`.

**Two decisions inside the migration worth finding again:**

- `identity_for_email()` matches with `or` across the two role tables rather
  than `coalesce(s.email, t.email)`. The coalesce reads as though it says the
  same thing and silently prefers the student address if an identity ever held
  both roles. It cannot today — `identity_one_role_check` — but the `or`
  degrades to "several matches, refuse", which is the safe direction, and a rule
  resting on a constraint elsewhere should say so out loud.
- `class_session_teacher_own_select` matches only the rows naming *you*, so a
  co-teacher on the same session stays invisible. A real restriction, chosen:
  a roster is who attended, not who else was on staff.

**The riskiest line in the file is one that is not there.** Every policy compares
with `=`, so a NULL `current_teacher_id()` yields NULL, never true. One `is null`
anywhere would open every row to every signed-in student. There is none.

**Section G ends with two assertions that are the real point.** G6: a teacher
sees no `creation` rows, because `0055` adds no policy there — whose work is
shown to whom is a separate question and must not be inherited from a roster
policy. G7: an UPDATE on a row she *can read* is refused, so the read-only
promise is enforced by the database rather than by everyone remembering it. The
mutation table in the file header now lists what to drop to turn G2, G5 and G7
red.

`npm run verify` — 844 tests pass, format, lint and typecheck clean. That proves
nothing about the SQL: **`0055` has not been applied and section G has not been
run.** Both need the SQL editor.

**Next, in order:** apply `0055`; run the whole check file and confirm sections
A–F still pass *unchanged* alongside the new G; then the portal half — `/api/v1/me`,
the `proxy.ts` guard for `/teacher`, role-aware post-verify redirect, and the
roster page.

### 2026-10-09 — 42P17: the migration was applied, and it was wrong

The user applied `0055` and ran `portal_auth_isolation.sql`. Sections A–F
passed; G2 died:

```
ERROR 42P17: infinite recursion detected in policy for relation "attendance_record"
```

**The cycle, and the false claim that hid it.** `attendance_record_taught_select`
read `class_session_teacher` inline; `0053`'s
`class_session_teacher_attended_select` on that table reads `attendance_record`;
round it goes. The migration carried a comment asserting "there is no cycle —
`class_session_teacher`'s own policy names no table", which was simply false and
was never checked against `0053`. A comment stating a safety property that
nothing verifies is worse than no comment.

**It was not only section G.** `app.student` now carries two permissive policies,
OR'd, and `student_taught_select` reached into the loop — so a signed-in
**student** could hit the same 42P17 depending on planner ordering. A–F passing
proved short-circuiting on those rows, not safety. For the window between the
apply and the fix, live student reads were at risk.

**Fixed by the pattern `0053` already established, one level out.** Three
`security definer` functions — `teaches_session`, `teaches_cohort`,
`teaches_student` — so the policies read no tables and a cycle is impossible
rather than absent by luck. `0055` is **amended in place and must be re-run**,
exactly as `0053` was amended after its `min(uuid)` bug.

**A new trailing check asserts the rule rather than describing it:** no policy
added by this migration may have `FROM app.` in its `qual`. That check would have
caught this before it reached the database.

**What this says about the process, written down because it will recur.** Nothing
in `npm run verify` exercises a policy — 844 tests passed over a migration that
could not run. SQL correctness here is proved only in the SQL editor, so
"committed and tests pass" must never be reported as more than it is.
