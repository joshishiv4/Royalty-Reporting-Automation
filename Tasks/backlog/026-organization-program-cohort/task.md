---
id: 026
title: organization, program and cohort — the context row's source
status: backlog
priority: high
depends_on: [025]
created: 2026-09-17
---

# `organization`, `program`, `cohort`

## Goal

The dashboard's context row shows three chips — a program ("Podcasting"), an
organization ("Sid Jacobson JCC") and a class group ("Podcasting Group 1"). **None
of these exists in WellnessLiving.** They cannot be synced, now or ever; they are
authored data.

## Scope

- `organization`, `program`, `cohort` tables
- Their relationship to `student` (which student is in which cohort/program)
- Seeding whatever the live studio actually has today

## Out of scope

- `cohort_link` and the WL projection — task 031 fills these tables from `session`.
- An admin UI. See the open question below.

## Multi-org — asked, and deliberately deferred

Asked 17 Sep 2026 how many businesses this must serve. The answer was: not known,
possibly several.

So: **build for one business now, but place the columns and foreign keys so that
adding multi-org later is a migration, not a redesign.** Concretely — `organization`
exists as a real table from day one even while it holds one row, and `program` and
`cohort` hang off it rather than off a constant.

Note that `k_business` is `NOT NULL` on every WL-derived table. `k_business` is a
*WellnessLiving* business id; `organization` is not. Keep them distinct — "Sid
Jacobson JCC" is an organization and is not a WL business, which is precisely why
one cannot stand in for the other.

## Open question — who enters this data?

There is no admin UI in this project and nothing in `src/` writes authored content.
Two options, and the scope of this task depends on which:

- **(a) Seed migration** — fixed, one-off, changed by a migration each time.
- **(b) A small admin screen** — more work, but the studio can maintain it.

Not yet answered by the user. **(a) is assumed** for now because it is the smaller
first step and does not foreclose (b); if the studio needs to change a program name
without a deploy, (b) becomes necessary and should be split into its own task.

## Acceptance criteria

- [ ] `organization`, `program`, `cohort` exist, following the `0034`/`0035`
      conventions
- [ ] **No WellnessLiving field on any of them** — per the rule established in 025
- [ ] `organization` is a table, not a constant, and holds the studio's real row
- [ ] A student resolves to their program, organization and cohort
- [ ] Adding a second organization requires a migration and no schema redesign —
      demonstrated, not asserted
- [ ] RLS: a student can read their own context and nobody else's
- [ ] DATA-MODEL.md and ARCHITECTURE.md updated in the same commit

## Resources

- `resources/` — empty. The fixture shapes are in
  `spin-dj-pathways/REQUIRED_APIS.md` under "Context row".
