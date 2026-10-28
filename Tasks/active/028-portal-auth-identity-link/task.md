---
id: 028
title: Portal auth — email OTP sign-in linked to an identity
status: active
priority: high
depends_on: [025]
created: 2026-09-17
updated: 2026-10-08
---

# Portal auth — email OTP sign-in, linked to an identity

## Goal

A student signs in to the portal with a **one-time code sent to their email**, and
the database answers "which human is this" with exactly one `identity` — after
which Row Level Security, not application code, decides what they can read.

The second half is the point. A login screen that still reads through the service
role has added a door to a building with no walls.

## Decisions, 8 Oct 2026

Taken by the user after the options were put with their costs.

1. **Sign-in is closed.** A code is sent only to an address already in the
   database. No account is created by signing in (`shouldCreateUser: false`).
2. **Supabase Auth issues the code, not us.** See "Why not a home-made OTP table".
3. **Portal-native signup is deferred, not cancelled.** The original headline
   criterion of this task — "a student who has never existed in WellnessLiving...
   that case is the entire reason the hub exists" — is **not met by this round**,
   by decision. Recorded here rather than quietly dropped from the list.
   It costs nothing today: **0 of 1,297 identities lack a WL `uid`**, so no
   portal-native human exists yet to be locked out. The hub still earns its place
   as the auth anchor.

## Why not a home-made OTP table

Every access rule in this database is `auth.uid()`. A hand-rolled OTP issues no
JWT, so RLS can never engage and every route keeps the service-role key — the
exact thing `spin-dj-pathways/app/lib/supabase.ts` says must be replaced: "at which
point the route stops being able to read anybody else's rows even by mistake, which
is the actual protection."

Supabase Auth sends a **link** by default. The switch that makes it a 6-digit code
is the email template — `{{ .Token }}` in place of `{{ .ConfirmationURL }}`. Same
API, different template. Nothing is gained by building the rest.

## Measured, 8 Oct 2026 — read-only against live

Measured because `student.email` carries **no unique constraint** (`0039`), so
"sign in with your email" had no guaranteed answer. It does not have one.

| | |
|---|---|
| `app.student` rows | 1,297 |
| with an email | 1,280 |
| **no email at all** | **17** — these students cannot sign in by email, ever |
| distinct addresses | 1,208 |
| addresses on more than one row | 51, covering 123 rows |
| **worst collision** | **16 student rows share one address** |
| `identity.auth_user_id` populated | **0** — nobody has ever signed in |
| identities with no WL `uid` | 0 |
| `student` rows no identity references | 47 — the known orphans (DATA-MODEL.md) |

**What a closed sign-in admits today:** 1,112 of 1,250 student identities resolve
from exactly one address. 50 addresses resolve to more than one and are refused.

So the rule cannot be "find a student with this email". It must be **exactly one**.

## The sign-in rule, exactly

On a request for a code, and again on verification:

| Identities matching the address | Answer |
|---|---|
| exactly 1, with a `student` role | send the code; on verify, link `auth_user_id` and admit |
| 0 | no code, no account, no row created |
| 2 or more | **no code.** Ambiguous, and guessing admits one human to another's data |
| already linked to a different `auth_user_id` | no code; this is a collision, not a login |

The reply to the browser is the **same** in every refusing case — the form must not
become an oracle for which addresses exist.

## Scope

- Migration `0053` in this repository:
  - Drop `person.auth_user_id`; rewrite `0010`'s five policies through `identity`.
    DATA-MODEL.md already prescribes this: "One auth anchor, not two... while the
    cost is still zero rows." The cost is still zero rows — 0 of 1,297.
  - SELECT policies on the `app` tables the dashboard actually reads — `student`,
    `class_session`, `attendance_record`, `cohort`, `class_session_teacher`.
    Without these, signing in makes the dashboard **emptier** than it is today:
    those tables are RLS-enabled with no policies (`0048`).
  - A `security definer` helper over `organization_membership`, so a policy does
    not join it inline on every row (prescribed, DATA-MODEL.md).
  - A `security definer` RPC performing the first-sign-in link, so "one auth user,
    one identity" is enforced by `identity_auth_user_id_key` inside one statement
    rather than by application code racing itself.
  - Enable RLS on `raw_wl` and `raw_ghl` — they have **none at all** today and hold
    whole API responses for every client (prescribed, DATA-MODEL.md).
- `supabase/checks/portal_auth_isolation.sql`, extending the `rls_isolation_test.sql`
  pattern: two auth users, faked JWTs, each sees only their own rows, rolled back.
- In `spin-dj-pathways`: `@supabase/ssr`, cookie sessions, middleware, the OTP
  screens, and `/api/v1/students/me/dashboard` replacing the id-in-the-path route.

## Out of scope

- **All writes.** Unchanged from the original: `0010` states "Every policy below is
  SELECT only. The portal reads; nothing about it writes." That stays true.
- Portal-native signup (deferred, see Decisions).
- Matching a portal student to a WL person — task 030.
- An admin screen for the 50 ambiguous addresses and the 17 with none. They get a
  RUNBOOK entry, not a UI.

## Acceptance criteria

- [ ] A student whose address resolves to exactly one identity receives a 6-digit
      code by email and signs in with it
- [ ] An address with 0 matches, 2+ matches, or no email gets **no code and no
      account**, and the browser cannot tell those cases apart
- [ ] A signed-in student resolves to exactly one `identity`
- [ ] One auth user cannot be linked to two identities — proven by attempting it,
      not by reading the index definition
- [ ] Student A cannot read student B's rows — **proven by a test that fails when a
      policy is dropped**, not by inspection
- [ ] The dashboard route accepts **no id**; `/students/me` is the only address
- [ ] A request with no session cookie gets 401, not somebody's data
- [ ] No write policy is added
- [ ] Signing out ends the session server-side, not just by routing to `/login`
- [ ] `raw_wl` and `raw_ghl` are RLS-enabled
- [ ] RUNBOOK.md covers: a sign-in resolving to no identity; the 17 students with
      no address; the 50 ambiguous addresses; and rotating the Supabase SMTP
      credential
- [ ] DATA-MODEL.md, ARCHITECTURE.md and STATUS.md updated **in the same commit**

## Blocking bug found while measuring, 8 Oct 2026

`GET /rest/v1/student` with no `Accept-Profile` returns **404 PGRST205, "Could not
find the table 'public.student'"**. PostgREST's default profile is `public`;
`0047` moved the eleven portal tables to `app`.

`spin-dj-pathways/app/lib/supabase.ts` creates its client with no `db.schema`, so it
defaults to `public`, and every `.from('student')` in the dashboard route misses.
**That route cannot have returned live data since `0047` landed.** It is invisible
because `live-data.js` falls back to fixtures on failure, which is exactly the
confusion that file was written to prevent.

The fix is `{ db: { schema: 'app' } }` on the client, or an explicit `.schema('app')`
per query. It must be settled before any of this task can be verified — a sign-in
cannot be proven to return the right rows while it returns none.

## Constraints & notes

- RLS is on with no policies by default here, deliberately: "a table that is open
  until someone remembers to close it is open" (`0001`). Any table this touches
  follows that.
- Views need `security_invoker = on` or they read past RLS with the owner's
  privileges. This has already been a real bug in this project.
- On the server, `getUser()` — never `getSession()`. `getSession()` trusts the
  cookie without revalidating the JWT.
- The service-role key must never reach the browser: no `NEXT_PUBLIC_` prefix, and
  nothing importing it may be a client component.
- Supabase's built-in SMTP sends only to project members at a few messages an hour.
  Custom SMTP is **required** before a real student can sign in. Credentials are
  configuration, and belong in RUNBOOK.md, never in source.
- Default OTP expiry is one hour. Shorten it.

## Step order

Both halves must land before this is called done — the policies are untestable
until something signs in, and the sign-in is meaningless until the policies isolate.

1. Settle the `app`-schema bug above
2. `0053` + the isolation check + docs (this repository)
3. Supabase dashboard: email OTP on, `{{ .Token }}` template, expiry, custom SMTP
4. `@supabase/ssr`, middleware, cookie session, sign-out (`spin-dj-pathways`)
5. The OTP screens replacing the role picker at `/login`
6. `/students/me` replacing `/students/[id]`, and `DEMO_STUDENT_ID` deleted

## Resources

- `resources/` — empty. See `supabase/migrations/0010` §1d, `0039`, `0048`, and
  "Why `0048` writes no RLS policy" in docs/DATA-MODEL.md.
