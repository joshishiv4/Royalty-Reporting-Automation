---
id: 029
title: Read endpoints and dashboard wiring — the four sections that have a source
status: backlog
priority: high
depends_on: [026, 028, 031]
created: 2026-09-17
---

# Read endpoints, and taking the dashboard off fixtures

## Goal

`spin-dj-pathways` renders entirely from `app/lib/fixtures.js`. This task makes live
the sections that have a real source behind them, and leaves the rest honestly on
fixtures.

## What can actually go live, and what cannot

[`REQUIRED_APIS.md`](../../../../spin-dj-pathways/REQUIRED_APIS.md) specifies 22
endpoints. After the owned-content tables were dropped from this round (user, 17 Sep
2026), **four sections have a source**:

| Section | Endpoint | Source |
|---|---|---|
| Identity | `GET /students/me` | `identity` + `student` (025) |
| Context row | `GET /students/me/context` | `organization`/`program`/`cohort` (026) |
| Next session | `GET /students/me/sessions/next` | `class_session` (031) |
| Schedule | `GET /students/me/sessions` | `class_session` (031) |

The other eight sections — pathway, current project, interests, progress, feedback,
creations, opportunities, journey — have **no source in WellnessLiving and no owned
table yet**. They stay on fixtures, and that is recorded here rather than discovered
later.

All four write endpoints are likewise out of scope: every one of them targets a
dropped table.

## Which repository this lands in

**The endpoints live in `spin-dj-pathways`, not here.** Decision, 17 Sep 2026:
sync and database work stays in the royalty repository; the dashboard API is built
alongside the dashboard.

That repository already depends on the Supabase client, so it reads the database
directly. The `api/` routes in the royalty repository stay what they are — sync
triggers and health — and gain nothing student-facing.

**The cost of the split, stated once so it is not discovered later:** two
repositories now read one schema, and the schema is owned by neither jointly. A
migration here can break the dashboard with nothing in either build catching it.
Whatever this task does about that — a shared contract, a test in the dashboard
that fails on a schema change, or at minimum a note in both repositories — is worth
more than the endpoints themselves.

## Scope

- The four GET endpoints above, built in `spin-dj-pathways`
- `GET /students/me/dashboard` returning **only** the live sections
- Replacing those four fixtures with real fetches
- Something that notices when the schema underneath moves

## Out of scope

- The other 18 endpoints and all 4 write endpoints
- Any component redesign — see below

## The response shape is already fixed

`REQUIRED_APIS.md` states the response shape **is** the fixture shape, so no
component needs to change. Honour that. If an endpoint's natural shape differs from
its fixture, change the endpoint, not the component — otherwise this task quietly
becomes a UI rewrite.

One known deviation to handle: fixtures carry pre-formatted `dateLabel`/`timeLabel`
strings; endpoints return raw ISO values and formatting moves into a `formatters`
util. That is called out in REQUIRED_APIS.md and is expected work, not scope creep.

## Acceptance criteria

- [ ] The four endpoints return the documented shapes
- [ ] `/students/me/dashboard` returns the live sections and **omits** the rest —
      it does not return empty stubs that look like missing data
- [ ] The dashboard renders those four sections from the API with **no component
      changed** beyond date formatting
- [ ] The remaining eight sections still render from fixtures and are visibly
      unbroken
- [ ] **The stated requirement, tested end to end**: a student with a next session in
      WL sees that session in the portal
- [ ] A portal-native student sees an empty schedule, not a fabricated one
- [ ] Each endpoint is authorised — student A cannot read student B by changing an id
- [ ] A short note in the dashboard repo saying which sections are live and which are
      still fixtures, and why

## Constraints & notes

- Auth is a bearer token and the authenticated student is implied — `me`, never an id
  in the path. Do not add an id parameter "for testing"; that is the authorisation
  hole.
- All WL keys are text. Money is `numeric(12,2)`, never float.
- Hosts never appear in source, logs or stored records.

## Resources

- `resources/` — empty. The contract is `spin-dj-pathways/REQUIRED_APIS.md`; the
  current data source is `spin-dj-pathways/app/lib/fixtures.js`.
