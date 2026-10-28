# Teacher email measurement — 9 Oct 2026

Read-only against the live dev project, through PostgREST with the service role
key (`Accept-Profile: app`). Nothing was written. This is the teacher equivalent
of the student measurement in task 028, run before the PRD so the admission test
was designed against the data rather than against an assumption.

## How it was run

Three reads, then compared locally — PostgREST caps a page at 1,000 rows, so
`student` and `identity` were paged with a `Range` header:

```
GET /rest/v1/teacher?select=id,email,first_name,last_name
GET /rest/v1/student?select=id,email            (paged)
GET /rest/v1/identity?select=id,teacher_id,student_id,auth_user_id,uid,k_staff  (paged)
```

Addresses compared as `lower(trim(email))` — the same normalisation
`app.identity_for_email()` applies.

## Results

### app.teacher

| | |
|---|---|
| rows | 47 |
| with an email | 47 |
| no email at all | 0 |
| distinct addresses | 47 |
| addresses on more than one teacher row | 0 |

Unlike the student roll (51 duplicated addresses over 123 rows), `teacher` is
clean on its own.

### Identity linkage

| | |
|---|---|
| identities with `teacher_id` | 47 |
| identities with `student_id` | 1,251 |
| identities with neither role | 0 |
| identities with **both** roles | 0 |
| teacher rows with no identity | 0 |
| teacher identities holding `auth_user_id` | 0 |

### The cross-role overlap

| | |
|---|---|
| teacher addresses also on a student row | **47 of 47** |
| `app.student` rows | 1,298 |
| student rows holding an identity | 1,251 |
| **student rows with no identity** | **47** |

The two 47s are the same 47 humans. WL carries each teacher as both a staff
record and a client record; `0040`'s trigger applied the rule from `0039` — staff
profile type wins, everyone else is a student — and attached the identity to the
teacher role, leaving the duplicate student row with no identity pointing at it.

This is why a `count(*) = 1` test across both roles still works: the orphaned
student rows are invisible to a join through `identity`.

### What a widened identity_for_email() would answer

Simulated locally over the 47 addresses, joining `identity` to either role:

| | |
|---|---|
| exactly one identity (would sign in) | **46** |
| zero (refused) | 0 |
| several (refused, ambiguous) | **1** |

The one: **Jared Feldman**, `ja***@spindjacademy.com` — one teacher row, two
student rows, one of those students carrying its own identity. Two identities,
so NULL, so the uniform 202 and no code. A real teacher, refused. Handled as a
decision in `task.md`, not a tie-break in the function.
