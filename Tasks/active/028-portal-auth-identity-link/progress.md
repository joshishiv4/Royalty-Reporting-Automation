# Progress: Portal auth

## Checklist

- [x] Settle the `app`-schema bug — the dashboard route queries `public`, the tables live in `app`
- [x] Fix the unbounded `.in()` that broke the route for the 21 busiest students
- [ ] `0053`: drop `person.auth_user_id`, re-point `0010`'s five policies through `identity`
- [ ] `0053`: SELECT policies on the `app` tables the dashboard reads
- [ ] `0053`: `security definer` membership helper, and the first-sign-in link RPC
- [ ] `0053`: enable RLS on `raw_wl` and `raw_ghl`
- [ ] `supabase/checks/portal_auth_isolation.sql` — two JWTs, each sees only its own, rolled back
- [ ] Prove student A cannot read student B, by removing a policy and watching the check fail
- [ ] Supabase dashboard: email OTP on, `{{ .Token }}` template, shorter expiry, custom SMTP
- [ ] `@supabase/ssr`, cookie session, middleware guard, real sign-out
- [ ] The OTP screens replacing the role picker at `/login`
- [ ] `/students/me` replacing `/students/[id]`; `DEMO_STUDENT_ID` deleted
- [ ] Confirm no write policy was added
- [ ] RUNBOOK.md: sign-in resolving to no identity; the 17 with no address; the 50 ambiguous; SMTP rotation
- [ ] DATA-MODEL.md, ARCHITECTURE.md, STATUS.md — same commit as the change

## Last step

Step 1 done, 8 Oct 2026 — both route bugs fixed in `spin-dj-pathways` and proven
against live data. Next is `0053`.

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
