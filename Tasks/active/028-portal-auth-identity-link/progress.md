# Progress: Portal auth

## Checklist

- [x] Settle the `app`-schema bug — the dashboard route queries `public`, the tables live in `app`
- [x] Fix the unbounded `.in()` that broke the route for the 21 busiest students
- [x] `0053`: drop `person.auth_user_id`, re-point `0010`'s five policies through `identity`
- [x] `0053`: SELECT policies on the `app` tables the dashboard reads
- [x] `0053`: `security definer` membership helper, and the first-sign-in link RPC
- [x] `0053`: the `SELECT` grants — `0047` gave `app` tables to `service_role` only
- [x] `0053`: enable RLS on `raw_wl` and `raw_ghl`
- [x] `supabase/checks/portal_auth_isolation.sql` — two JWTs, each sees only its own, rolled back
- [x] **Apply `0053` in the SQL editor** — applied 8 Oct 2026; all five helpers
      `SECURITY DEFINER` with `search_path=""`
- [x] **`portal_auth_isolation.sql` passes** — A–F all green, 8 Oct 2026, after
      `0053` was amended and re-run
- [x] **`rls_isolation_test.sql` passes** — the WL mirror, 8 Oct 2026; no exception
      and zero rows from its guard, so `0040`'s trigger still fires too
- [x] Escaped `like` guard confirmed - the final select returns ZERO rows
- [x] **`rls_isolation_test.sql` re-run after its repairs** — 8 Oct 2026, still
      "Success. No rows returned"; the file in the repo is the file that passed
- [x] Prove student A cannot read student B, by removing a policy and watching the
      check fail - measured 8 Oct 2026: dropping `student_self_select` turns A1 and
      C1 red and nothing else
- [ ] Supabase dashboard: email OTP on, `{{ .Token }}` template, shorter expiry, custom SMTP
- [ ] `@supabase/ssr`, cookie session, middleware guard, real sign-out
- [ ] The OTP screens replacing the role picker at `/login`
- [ ] `/students/me` replacing `/students/[id]`; `DEMO_STUDENT_ID` deleted
- [ ] Confirm no write policy was added
- [x] RUNBOOK.md: §10 sign-in, §4f the Supabase Auth SMTP that is NOT the sync's
- [x] DATA-MODEL.md, ARCHITECTURE.md, STATUS.md — same commit as the change

## Last step

`0053` is applied and both check files pass, 8 Oct 2026. The migration had one
real defect - `min(uuid)`, which would have failed every first sign-in - and the
portal check had three of its own. The mutation is measured: dropping
`student_self_select` turns exactly A1 and C1 red. Step 2 is done. Step 3 is the
Supabase dashboard config: email OTP on, `{{ .Token }}` template, shorter expiry,
custom SMTP.

## Blockers

- **Not proven end to end.** The fixes are verified at the query layer, using the
  portal's own installed supabase-js and the route's real query chain. The route
  was *not* run inside Next, because that needs `.env.local` and writing a
  service-role key into a new file was refused — correctly. See the log.
- **The portal repo has no lint.** `npm run lint` fails (`next lint` was removed in
  Next 16) and there is **no ESLint config file at all**. So nothing automated
  would have caught either bug, and nothing will catch the next one. Deciding what
  to do about that is not part of this task, but it is why both fixes below carry
  their measurements in comments rather than in a test.

## Log

### 2026-09-17
- Task created.

### 2026-10-08 — scope settled with the user, and the task rewritten

Three decisions, taken after the options were put with their costs:

- **Closed sign-in.** A code goes only to an address already in the database, and
  signing in never creates an account. `shouldCreateUser: false`.
- **Supabase Auth issues the code.** Not a home-made `otp_code` table. The reason
  is not preference: every rule in this database is `auth.uid()`, and a hand-rolled
  OTP issues no JWT, so RLS could never engage and every route would keep the
  service-role key. That is the thing portal auth exists to remove.
- **Portal-native signup is deferred.** This was the original headline criterion of
  this task. It is recorded as deferred rather than deleted. Cost today is zero:
  0 of 1,297 identities lack a WL `uid`.

### 2026-10-08 — measured: email does NOT identify a student

Run read-only against live before fixing the sign-in rule, because
`student.email` has no unique constraint (`0039`) and the rule depended on it.

| | |
|---|---|
| `app.student` rows | 1,297 |
| with an email | 1,280 |
| no email at all | **17** |
| distinct addresses | 1,208 |
| addresses on more than one row | 51, covering 123 rows |
| worst collision | **16 rows share one address** |
| `identity.auth_user_id` populated | **0** |
| identities with no WL `uid` | 0 |
| `student` rows no identity references | 47 |

So "find the student with this email" would have admitted one human to another's
data in 50 cases. The rule is **exactly one match, or no code** — and the browser
is told the same thing whether the address matched 0, 2 or 16 rows, so the form
cannot be used to discover who has an account.

Two measurements confirm the docs are still true rather than merely plausible:
`auth_user_id` is empty on every row, as `0048` claims, and the 47 orphaned
`student` rows are exactly the gap DATA-MODEL.md records.

Only 1,112 of 1,250 student identities can sign in under this rule. The remaining
138 are the 17 with no address and the ~121 sharing one. They need a human, not a
guess, so they get a RUNBOOK entry.

### 2026-10-08 — BUG found while measuring: the dashboard reads the wrong schema

`GET /rest/v1/student` with no `Accept-Profile` returns **404 PGRST205**, *"Could
not find the table 'public.student'"*. PostgREST's default profile is `public` and
`0047` moved the eleven portal tables to `app`.

`spin-dj-pathways/app/lib/supabase.ts` builds its client with no `db.schema`, which
defaults to `public`, so every `.from('student')` in
`app/api/v1/students/[id]/dashboard/route.ts` misses. **That route cannot have
returned live data since `0047` landed.**

It is invisible from the UI: `live-data.js` treats a failed fetch as "fall back to
fixtures", so a broken route and a slow one look the same on screen. That file's
own header warns about exactly this — *"a failed fetch cannot quietly masquerade as
real data"* — and `isLive` is presumably false for everyone right now.

Fix is small (`{ db: { schema: 'app' } }`, or `.schema('app')` per query). Logged
rather than fixed on the spot: it belongs to the portal repository and wants its
own commit with whatever test keeps it from recurring.

### 2026-10-08 — step 1 done: the dashboard route now returns data, for every student

Two bugs, not one. The second was found only because the first was fixed and the
next query was then allowed to run.

**Bug 1 — the client read the wrong schema.** `app/lib/supabase.ts` built its
client with no `db.schema`, so supabase-js defaulted to `public`, while `0047`
moved the eleven portal tables to `app`. Every `.from('student')` and
`.from('creation')` asked for a table that does not exist.

Checked before changing it: all thirteen relations the portal reads are in `app`
and **none** of them exists in `public`, so a default on the client is right and
a per-query `.schema('app')` would only be something to forget. Fixed with
`db: { schema: 'app' }`.

The client's TYPE then had to stop being written by hand — `SupabaseClient`
defaults its schema parameter to `public` and rejected the `app` client. It is now
derived from the factory (`ReturnType<typeof build>`), so a supabase-js version
that reshuffles its five generic parameters cannot break this file again.

**Bug 2 — an unbounded `.in()` filter.** The route collected every
`class_session_id` a student ever attended and passed the whole list to one
`.in()`. PostgREST takes filters in the query string, so the URL grows with the
list and the request fails before it is sent.

Measured, uuid keys at ~37 chars each:

| ids | approx URL | result |
|---|---|---|
| 300 | 11,100 chars | ok |
| 400 | 14,800 chars | `HeadersOverflowError` — no status code to read |
| 669 | 24,800 chars | `Bad Request` |

Not hypothetical. `attendance_record` holds **45,987 rows across 904 students**;
the median student has 12, the busiest has **1,257**, and **21 students are
already over 300**. Their dashboards returned a 500, which the UI rendered as
fixtures. Fixed by chunking at 200 — half the first failing size, leaving room for
any proxy with a tighter limit than Node's — and sorting once after the merge,
since the batches are each ordered but not ordered against each other.

**Proof, read-only against live.** The route's real query chain replayed with the
portal's own installed supabase-js, in three configurations:

| student | before | schema fix only | schema + chunking |
|---|---|---|---|
| busiest, 669 attendance rows | fail | **fail** | ok — 669 sessions, 53 upcoming, 572 attended |
| 97 rows | fail | ok | ok — identical |
| demo student, 265 sessions | fail | ok | ok — identical |

Both fixes are load-bearing, which is the point of the middle column: remove the
schema fix and all three fail; remove the chunking and only the 669-row student
fails, exactly at the measured threshold. Ordering verified after the merge in
every case, and the two students below the threshold return byte-identical counts
with chunking on, so it changes nothing except whether the request survives.

`tsc --noEmit` clean.

**What is NOT proven:** the route running inside Next. That needs `.env.local`,
and creating it was refused because it copies a service-role key into a new file —
the right refusal. To close it, the user creates `spin-dj-pathways/.env.local`
with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the same pair as the sync
service; the file is gitignored), then `npm run dev` and fetch the route.

**Found, not fixed, recorded:** the portal repo cannot be linted. `npm run lint`
runs `next lint`, which Next 16 removed, and there is no `eslint.config.*` file at
all. Neither bug above would have been caught by anything automated.

### 2026-10-08 — step 2 written: migration 0053, two checks, four docs

`0053` does the four things DATA-MODEL.md has asked for since `0048`, plus a fifth
nobody had written down.

**One auth anchor.** `person.auth_user_id` is dropped and `0010`'s five policies
re-point through `identity`. A guard refuses the drop if any row carries one — the
measurement that says it is safe was taken on 8 Oct and is not a promise about the
day this is applied.

**The order of that drop is load-bearing, and the first draft had it wrong.** All
five of `0010`'s policies read `person.auth_user_id`, so Postgres records a
dependency and refuses to drop the column while they exist. `CASCADE` would have
taken the policies with it and left the mirror with RLS on and nothing granted —
every row readable by nobody, found later as "the portal shows nothing". The five
are now dropped by name first and rebuilt in section 3.

**The helpers are not an optimisation.** A policy's subquery runs as the caller, so
a policy on `app.student` that read `app.identity` inline would be filtered by the
policy on `app.identity`, and the lookup establishing who you are returns nothing.
All four are `security definer` with `search_path` pinned to `''`.

**A fifth thing, not in DATA-MODEL's list: the grants.** `0047` granted `USAGE` on
schema `app` to `authenticated` and then granted table privileges to
`service_role` only. In `public` the question never arises because Supabase's
bootstrap sets default privileges there. The failure is not an empty read but
`permission denied for table student` — a 42501 — which is why reading the
policies alone would not have predicted it. `0053` adds the `SELECT` grants and
revokes `anon` outright.

**The link function takes no parameters**, deliberately. The email comes from the
JWT claim Supabase Auth has just verified by sending a code to it; a parameter
would let any signed-in caller name any address and be linked to that human. It is
idempotent, and it refuses zero and many with the *same* error so the caller cannot
tell them apart.

**Checks.** `portal_auth_isolation.sql` is new and covers the `app` tables, the
helpers, the link function and the one-auth-user-one-identity index — the last
proven by attempting the second link, not by reading the index definition. Alice
and Bob in it are **portal-native**: no `uid`, no `person` row, which is the case
the hub exists for. `rls_isolation_test.sql` had to change too: it inserted
`person.auth_user_id`, which `0053` removes. It now links on the hub, and because
the person insert fires `0040`'s trigger, that update also quietly proves the
trigger still runs.

**NOT APPLIED AND NOT RUN.** Two separate gaps, and neither is a detail:

- `0053` is applied by hand in the Supabase SQL editor, as `0039`–`0049` were.
  Until somebody does that, every policy here is a file.
- `npm run verify` could not run: **`ENOSPC`, no space left on device.** C: has
  **0 MB** free. The migration-table rule was checked by hand instead (53
  migrations, none unregistered), but the other 800-odd tests did not execute.
  Nothing in this step touches TypeScript, which lowers the risk and does not
  remove it.

### 2026-10-08 — `0053` applied, and the check's own bug

Applied in the SQL editor. The migration's three trailing verification selects
pass: five helpers, all `prosecdef`, all `search_path=""` rather than
`(none - UNPINNED)`.

`portal_auth_isolation.sql` then aborted:

    ERROR: 42501: permission denied for table student
    HINT:  GRANT SELECT ON app.student TO anon;
    CONTEXT: select count(*) from app.student where last_name like '__pa_%'

**The check was wrong, not the migration, and it was wrong in the direction of
being too weak.** Section D asked whether a signed-out caller sees zero rows, so
it assumed `anon` reaches the table and is filtered by policy. `0053` revokes
anon outright, and table privileges are checked *before* row security — so anon
is refused at the grant and never reaches RLS at all. The guarantee the database
actually provides is the stronger one, and the test could not express it.

D1 now runs the select inside a sub-block and treats `insufficient_privilege` as
the PASS; reaching the table at all, with any row count, is the FAIL. That keeps
it able to fail for the right reason: re-grant anon and leave the policies to do
the work, and D1 goes red where the old version would have gone green. The
mutation is recorded in the file header beside the three policy drops.

Not re-run yet. Because the `do` block raised, the transaction aborted and the
`rollback;` ran, so nothing was kept — but **E (the first-sign-in link) and F
(one auth user cannot hold two identities) have never executed**, and nothing
about them is proven.

The HINT Postgres printed is the one change that must not be made.

### 2026-10-08 — the check found a real bug in `0053`: `min(uuid)`

With D1 fixed the run reached the end and reported `5 portal auth check(s)
FAILED`. The Supabase SQL editor does not surface `RAISE NOTICE`, so a count was
all it said. Every `FAIL` line now also appends to a `text[]` that the closing
`raise exception` prints, which turned five anonymous failures into one named
cause:

    FAIL E1 link raised function min(uuid) does not exist for a unique address
    FAIL E2 second call raised function min(uuid) does not exist
    FAIL E3 refused with the wrong error: function min(uuid) does not exist
    FAIL E4 refused with the wrong error: function min(uuid) does not exist
    FAIL F1 one auth user now holds two identities

**`link_signed_in_identity()` could never have run.** It used `min(i.id)` to pull
the single matching identity. `uuid` has btree ordering, so it sorts and `min()`
reads as though it should work, but core PostgreSQL ships no min/max **aggregate**
for the type. `check_function_bodies` only syntax-checks a plpgsql body — it does
not resolve the functions called inside its SQL statements — so `0053` created the
function without complaint and it raised `42883` on the first call. Every first
sign-in, for everyone, would have failed.

Fixed in place with `(array_agg(i.id))[1]`. Zero matches yields NULL, which is
harmless because `v_matches <> 1` refuses before the value is read.

**F1 was a knock-on, not a sixth defect.** E1 never linked dave, so claiming his
auth user for Carol One hit no conflicting row. The index F1 relies on,
`identity_auth_user_id_key`, does exist — `0039` line 258.

**A–D passed.** The policies, the four helpers, the grants and the anon revoke are
all sound; what was broken was the door, and only the door.

`0053` was amended rather than superseded by a `0054`. It is `create or replace`,
built to be re-run, nothing had ever called the function, and `0018`, `0029` and
`0030` were each edited after their introducing commit — so the precedent is the
repo's own. The cost is that the database and the file disagree until `0053` is
re-run.

### 2026-10-08 — the check passes, and its last line was crying wolf

`0053` re-applied with `(array_agg(i.id))[1]`, and `portal_auth_isolation.sql`
then ran to the end with no exception: **A through F all pass.** F1 went green on
its own, as predicted — once E1 links dave there is a real row for Carol One's
update to collide with, and `identity_auth_user_id_key` does the rest.

The final guard then reported three surviving rows after the rollback:

    Luis    Espana Rivera
    Jay     Kapadia
    Michelle Espada

**Those are real students, and the rollback was clean.** `_` is LIKE's
single-character wildcard, so `last_name like '__pa_%'` means "any two
characters, then `pa`, then any character, then anything" — Es-pa-d-a, Es-pa-n-a,
Ka-pa-d-ia. The guard that exists to prove the test data is gone was matching
live data instead, and printing people's names to do it.

Escaped in all nine places: `like '\_\_pa\_%'`. Backslash is LIKE's default escape
character, so `\_` is a literal underscore. The eight inside the `do` block were
harmless — they run under RLS as alice or bob, who can only see their own row —
but a predicate that is wrong for a reason unrelated to what it is testing is a
trap waiting for the next person, and the prefix was chosen to be unmistakable
precisely so this query could be trusted.

Re-run with the escape: ZERO rows. The isolation proof is complete.

### 2026-10-08 — the mutation, measured

`drop policy student_self_select on app.student;` then re-ran the check:

    2 portal auth check(s) FAILED:
    FAIL A1 alice sees 0 student rows ((none)), expected exactly 1 (alice)
    FAIL C1 bob sees [(none)], expected bob

**Exactly the two assertions that read `app.student` directly, and nothing else.**
The file header said "section A goes red", which was imprecise in both directions,
and is now corrected to the measurement.

A2 and A3 stayed green, and so did B1-B6. That is the design rather than a gap:
they resolve through `app.current_student_id()`, which is `SECURITY DEFINER` and
so does not run under the caller's policies, and the dependent policies match on
that helper rather than reading `app.student` themselves —
`attendance_record.student_id = app.current_student_id()`. One notion of "me" is
why one policy can be removed without the others quietly following.

C3 passes either way: it expects bob to see 0 organizations.

The other three mutations in the header are predictions, and are now labelled as
such. Policy restored by re-running `0053`.

### 2026-10-08 — `rls_isolation_test.sql` passes

Run after `0053` was restored: "Success. No rows returned". No exception means
`failures = 0`, and the guard at the end found nothing, so the rollback took. The
WellnessLiving mirror still isolates after `person.auth_user_id` was dropped, and
because the test now links through the hub it also re-proves `0040`'s trigger
fires.

Its anon section expects **0 rows** rather than a refusal, and that is correct
here: these tables are in `public`, where Supabase's own bootstrap grants anon by
default. That difference is exactly the gap `0053` had to close for `app`, where
nothing granted anything and the policies would have been theatre.

**Two defects in that file, found by reading it, not by running it.** Both
are the ones already fixed in `portal_auth_isolation.sql`:

- Failures report only through `RAISE NOTICE` and the closing `raise exception`
  carries a bare count. The Supabase SQL editor does not surface notices, so a
  future failure says how many and not which.
- The `like '__rls_test_%'` patterns are unescaped. Harmless today - WL keys are
  numeric and would have to contain literal `rls` and `test` to collide - but it
  is the same trap that reported three real students as surviving test data.

Fixed straight after the commit, on the ask, with the reasoning stated plainly:
neither defect made the passing run wrong. The escape could only over-match, never
hide a failure, and WL keys are digits so it could not match at all. The bare count
costs nothing until the day something fails - but that day cost two runs in the
sibling file, and the second run is what revealed `min(uuid)`. The real price of
the change is that this file now needs one run to be trustworthy again.

### 2026-10-08 — `rls_isolation_test.sql` brought level with its sibling

Both repairs applied: the four `FAIL` lines now append to a `text[]` that the
closing `raise exception` prints, and all six `like '__rls_test_%'` patterns are
escaped to `'\_\_rls\_test\_%'`.

Stated honestly, because "it passed, why change it" is the right question: neither
defect made the passing run wrong. An over-matching `LIKE` can only raise a false
alarm, never conceal a failure, so it could not have hidden anything; and a WL key
is digits, so it would have to contain the literal substrings `rls` and `test` to
collide at all. The bare failure count costs nothing on a green run. What it costs
is the first red one - measured today at two runs in `portal_auth_isolation.sql`,
and the second of those is what surfaced `min(uuid)`.

Re-run after the edit: "Success. No rows returned". The file in the repo is now
the file that passed, which is the whole point of running it again.
