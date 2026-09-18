---
id: 028
title: Portal auth — link a Supabase auth user to an identity
status: backlog
priority: high
depends_on: [025]
created: 2026-09-17
---

# Portal auth and the identity link

## Goal

A student signs in to the portal and the database must answer "which human is this",
including for **a student who has never existed in WellnessLiving**. That case is the
entire reason the hub exists, and it is the one the current schema cannot serve.

## This task spans both repositories

Decision, 17 Sep 2026: sync and database work stays in the royalty repository, the
dashboard API is built in `spin-dj-pathways`. Auth falls across that line.

- **Royalty repository** — the RLS policies and the link column. Those are
  migrations and belong where the schema lives.
- **`spin-dj-pathways`** — the sign-up and sign-in flow, and reading the signed-in
  student.

Neither half proves anything alone. The policies are untestable until something
signs in, and the sign-in is meaningless until the policies isolate. Plan to finish
both before calling this done.

## Scope

- Sign-up and sign-in against Supabase auth
- Linking `auth.users.id` to an `identity` row
- Creating an identity for a portal-native student — `uid IS NULL`, no `person` row
- Making the RLS policies from `0010` (re-pointed at the hub in task 025) actually
  isolate one signed-in student from another, proven

## Out of scope

- **All writes.** Every write endpoint the dashboard wants (`PUT /interests`,
  `PATCH /projects/{id}/stage`, `POST /opportunities/{id}/interest`) targets a table
  dropped from this round, so there is nothing to write to. This task stays read-only
  and the write posture is deliberately not opened.
- Matching a portal student to a WL person — task 030.

## What already exists

`person.auth_user_id` was added in `0010` with a partial unique index, and every RLS
policy there keys off it. Task 025 moves that column to the hub. This task is the
first thing that actually *uses* it — until now nothing has ever signed in.

`0010` states plainly: *"Every policy below is SELECT only. The portal reads; nothing
about it writes."* That stays true after this task.

## Acceptance criteria

- [ ] A student can sign up and sign in
- [ ] A signed-in student resolves to exactly one `identity`
- [ ] A **portal-native** student — no `uid`, no `person` row — signs up and resolves
      correctly
- [ ] That student's schedule, attendance and purchases come back **empty**, not
      fabricated. WL cannot know them; an empty answer is the true one
- [ ] Student A cannot read student B's rows — proven by a test that fails when a
      policy is removed, not by inspection
- [ ] No write policy is added by this task
- [ ] One auth user cannot be linked to two identities
- [ ] RUNBOOK.md covers what to do when a sign-in resolves to no identity

## Constraints & notes

- RLS is on with no policies by default in this project, deliberately: *"a table that
  is open until someone remembers to close it is open"* (`0001`). Any new table this
  touches follows that.
- Views need `security_invoker = on` or they read straight past RLS with their
  owner's privileges. This has already been a real bug here.

## Resources

- `resources/` — empty. See `supabase/migrations/0010`, section 1d.
