---
id: 032
title: Teacher sign-in — the same door, a read-only roster behind it
status: backlog
priority: high
depends_on: [028]
created: 2026-10-09
---

# Teacher sign-in — the same door, a read-only roster behind it

## Goal

A teacher signs in to the portal with the same email one-time code a student
uses, and Row Level Security — not application code — shows them **their own
roster and nothing else**: the students who attended sessions they taught.

The sign-in itself is nearly free. `0054` moved the admission test into one
function, `identity.teacher_id` has existed since `0039`, and nothing in the OTP
mechanism knows what a student is. **The work is the policy set**, because every
policy in `0053` resolves "me" through `app.current_student_id()`, and for a
teacher that is NULL.

## Measured, 9 Oct 2026 — read-only against live

The equivalent of task 028's email measurement, for teachers.

| | |
|---|---|
| `app.teacher` rows | 47 |
| with an email | **47 — every one** |
| no email at all | 0 |
| distinct addresses | 47, no duplicates within `teacher` |
| teacher rows with no `identity` row | 0 |
| teacher identities already holding `auth_user_id` | 0 |

**Every one of the 47 teacher addresses also appears on an `app.student` row.**
That sounds fatal for a `count(*) = 1` admission test and is not, because of how
`0040`'s trigger resolved them:

| | |
|---|---|
| `app.student` rows | 1,298 |
| students holding an `identity` | 1,251 |
| **students with NO identity** | **47 — exactly the teachers** |
| identities holding both roles | 0 (the `identity_one_role_check` holds) |

The staff profile type won. Each of these humans has one identity carrying
`teacher_id`, and their duplicate student row is orphaned — no identity points at
it. So an address-to-identity lookup across both roles still returns exactly one
answer for 46 of the 47.

**The exception, named because it will be the first support ticket.** Jared
Feldman's address sits on one `teacher` row and **two** `student` rows, one of
which has its own identity. The address therefore resolves to two identities and
the widened function returns NULL — he is refused, with the same uniform 202 as a
stranger. He is a real teacher at this studio. See "Constraints".

## Scope

**Migration (RRA repo)**

1. Widen `app.identity_for_email()` to admit an address on **either** role —
   `student.email` or `teacher.email` — still returning the single matching
   identity or NULL when zero or several match. `link_signed_in_identity()` calls
   it already and needs no change; that was the point of `0054`.
2. Add `app.current_teacher_id()`, the mirror of `current_student_id()`: the
   `teacher_id` of the caller's identity, NULL for everyone else. Same grants —
   `authenticated, service_role`, revoked from `public` and `anon`.
3. The teacher read policies, all `for select`, all hanging off that one
   function:

   | Table | A teacher may read |
   |---|---|
   | `app.teacher` | their own row |
   | `app.class_session_teacher` | rows naming them |
   | `app.class_session` | sessions they are named on |
   | `app.cohort` | cohorts those sessions belong to |
   | `app.attendance_record` | records for those sessions |
   | `app.student` | students holding such a record — **the roster** |
   | `app.identity` | their own row |

   Added **alongside** the student policies, never replacing them. Two permissive
   policies on a table are OR'd, so a student's reach is unchanged by
   construction — and that has to be proved, not assumed.

**Checks (RRA repo)**

4. Extend `supabase/checks/portal_auth_isolation.sql` with a teacher section:
   a teacher sees their roster, sees no student outside it, and **a student still
   sees exactly what section C already says they see**.

**Portal (spin-dj-pathways repo)**

5. A role in the session's own answer — `GET /api/v1/me` returning `student` or
   `teacher`, derived from the identity, never from a client-supplied value.
6. `proxy.ts`: guard `/teacher` as `/student` is guarded, and send each role to
   its own root. A teacher landing on `/student` and a student landing on
   `/teacher` must both be refused **without a redirect loop** — the current
   signed-in rule bounces `/login` to `/student` unconditionally.
7. `/auth/verify` chooses the post-sign-in destination by role, keeping
   `safeNext()`'s same-origin rule.
8. A `/teacher` roster page: cohorts, sessions, and the students on them.

## Out of scope

- **Any write.** No attendance marking, no feedback, no edits. Every policy this
  task adds is `for select`. The first write policy in this database is a
  separate task and a larger argument.
- Teacher-authored content, `creation` review, messaging.
- Repairing the 47 orphaned student rows. They are WL's duplicates, they are
  invisible today, and deciding what they are belongs to task 030.
- Portal-native teachers (a teacher with no WL `k_staff`). Same deferral as 028's
  portal-native students, for the same reason: none exist.
- Anything that changes what a student can read.

## Acceptance criteria

- [ ] `identity_for_email()` returns the identity for a teacher's address, still
      NULL for zero or several, and still `service_role` only.
- [ ] A teacher completes the OTP round trip and holds a session linked to the
      identity carrying their `teacher_id`.
- [ ] Signed in as a teacher, through the **anon** key: their roster is readable
      and a student outside it returns zero rows — not an error, zero rows.
- [ ] Signed in as a student, through the anon key: `portal_auth_isolation.sql`
      section C passes **unchanged** against the new policy set.
- [ ] No write succeeds as a teacher on any table in the scope table above.
- [ ] `/student` refuses a teacher and `/teacher` refuses a student, neither by
      looping.
- [ ] Jared Feldman's case is either resolved by a deliberate data decision or
      recorded in RUNBOOK §10a as a known refusal with the operator's remedy.
- [ ] DATA-MODEL.md, ARCHITECTURE.md's migration table and STATUS.md updated in
      the same commit as the migration.

## Constraints & notes

**The ambiguous teacher is a decision, not a bug to code around.** The admission
test must not prefer one role over another to break a tie — "prefer the teacher
row" would mail a code to whichever human holds that address and sign them in as
the teacher, which is precisely the wrong failure. The honest remedies are a data
fix (the second student row is a WL duplicate; task 030 territory) or an operator
note. Neither is a code change here.

**Do not relax `identity_one_role_check`.** `0039` records the rule — teacher and
student are exclusive — and the measurement confirms the trigger implements it.
A teacher who genuinely enrols as a student is the case that drops the
constraint, and that is a redesign with its own task, not a patch under this one.

**The policy set is additive and must be proved additive.** The cheap mistake is
rewriting a student policy to say "student or teacher" and silently widening what
a student reads.

**Gated by 028's remaining steps** — `0054` applied, SMTP and the `{{ .Token }}`
template configured. Teacher sign-in is unverifiable end-to-end until a code
actually arrives.

## Resources

- `resources/teacher-email-measurement.md` — the 9 Oct 2026 measurement above,
  with the queries that produced it, so it can be re-run.
