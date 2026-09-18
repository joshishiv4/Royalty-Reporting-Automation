---
id: 031
title: Session projection — cohort, class_session, attendance_record and their links
status: backlog
priority: high
depends_on: [025, 026]
created: 2026-09-17
---

# Session projection — `cohort`, `class_session`, `attendance_record`

## Goal

The portal must show a student their next session. The user's requirement, stated
17 Sep 2026: **if WellnessLiving shows the student a next session, the portal shows
it too.** Simple as that.

But the portal's tables must not be WL-shaped. This task projects WL's `session`
and `attendance` into owned tables that carry **zero WellnessLiving fields**, with
the mapping isolated in link tables.

## Why this needs link tables, and why the reason differs from task 025

WL compresses two levels into one table. [`0004`](../../../supabase/migrations/0004_session_attendance.sql)
says so directly: *"A CLASS ID REPEATS. `k_class` 268302 is 'A Joyful Noise | 60
Minutes' every week forever, so it identifies the class, not the occurrence."*

| Level | WL | Ours |
|---|---|---|
| Program | does not exist | `program` (task 026) |
| Series / class group | `k_class`, a **column**, no table | `cohort` (task 026) |
| Occurrence | `session`, PK `(k_period, dt_start_utc)` | `class_session` |

So WL has no key for the level the dashboard calls a class group.

Task 025's `identity` exists because **many sources describe one human**. The link
tables here exist for a different reason: **cardinality and shape** — one of ours
maps to many of theirs, and one of their columns is a whole table of ours. Same
pattern, different justification; do not assume the `identity` design transfers
column-for-column.

## The user's rule, and what it settles

**`class_session` and `attendance_record` carry no WL field.** No `k_period`, no
`k_class`, no `uid`, no `dt_start_utc` borrowed as a key.

That rule removes a design choice that was otherwise open. Putting a nullable
`k_period` on `class_session` would have made the link tables optional; it is ruled
out, so **the link tables are mandatory**.

## `attendance` gets a link table too — and the reason is provenance

An earlier draft of this task argued that `attendance` needs no link table, because
its WL key `(k_period, dt_start_utc, uid)` is already resolvable: the
`(k_period, dt_start_utc)` half through `session_link` and the `uid` half through
`identity`. That is true **for mapping** and it is the wrong conclusion, because
mapping is not the only thing the link carries.

The question the design has to answer is: **did this attendance come from
WellnessLiving, or was it entered in the portal?** Nothing in
`(class_session_id, student_id)` can answer it.

So `attendance_link` exists, and the invariant is:

> **A link row means WellnessLiving sent it. No link row means the portal did.**

Provenance is then **derived, never stored**. A `source` column would be the wrong
answer to the same question — it is a second place holding a fact the link already
holds, which is exactly what `0001` refused when it rejected an `is_staff` flag in
favour of "a non-null `k_staff` is the answer".

There is a third thing the link buys, which neither mapping nor a `source` column
would give: **collision detection**. If a session is marked attended in the portal
and WL later syncs the same attendance, that is two sources claiming one fact. The
link table is where it is caught. A `source` column would silently overwrite.

`session_staff` follows the same rule and gets a link as well.

Note the cost honestly: `attendance_link` grows one row per attendee per occurrence,
forever — the same order as `attendance` itself, and the largest table in this
design. Measure it; do not let it be a surprise.

## Scope

- `cohort_link` — `k_class` ↔ `cohort_id`
- `session_link` — `(k_period, dt_start_utc)` ↔ `class_session_id`
- `attendance_link` — `(k_period, dt_start_utc, uid)` ↔ `attendance_record_id`
- `session_staff_link` — the same, for the teaching side
- `class_session` — the occurrence, WL-free
- `attendance_record` — WL-free, keyed on ours
- Triggers projecting `session` and `attendance` forward, same rules as 025
- Cohort auto-stub (below)

Every projected table gets a link. The rule is uniform: **ours holds no WL field,
the link holds nothing else.**

## Out of scope

- Creating sessions **in** the portal. The shape allows a `class_session` with no
  link row so this is not foreclosed, but nothing is built for it here.
- `program` and `cohort` themselves — task 026 defines them; this task fills them.
- The Next Session **endpoint** — task 029.

## Cohort auto-stub — a decision taken, not an instruction

A WL session may carry a `k_class` nobody has mapped to a cohort. Left unmapped, the
Next Session card is empty until an admin does data entry — which fails the stated
requirement outright.

**So an unknown `k_class` auto-creates a stub cohort**, titled from
`session.text_title`, flagged unresolved. This is the stub-don't-fail pattern already
used for `location` and `service` (see `0012`'s `service.is_resolved` and the
`unresolved_service` view); the same shape should be reused rather than reinvented.

## Triggers

Same three rules as 025: **one direction only** (WL mirror → ours, never back),
**idempotent** bodies, and **backfill plus triggers in one migration**.

Note the volume difference from 025. `person` is ~1,285 rows; `session` and
`attendance` grow without bound, one row per occurrence per attendee forever. A
`WHEN` clause that fails to narrow will be much more expensive here than there, and
the backfill needs to be measured before it is assumed to be quick.

## Acceptance criteria

- [ ] `class_session` and `attendance_record` contain **no** column holding a WL
      value — verified by a test over the schema, not by reading it
- [ ] A WL session lands as a `class_session` with no application code involved
- [ ] A WL attendance row lands as an `attendance_record` keyed on ours, with an
      `attendance_link` row recording that WL sent it
- [ ] **Provenance is derived, not stored**: an attendance with a link reads as
      WellnessLiving, one without reads as portal, and no `source` column exists
      anywhere to disagree with that
- [ ] An attendance entered in the portal and then also sent by WL is detected as a
      collision, not silently overwritten
- [ ] **The requirement, tested directly**: take a student who has a next session in
      WL; the portal's data returns that same session
- [ ] An unknown `k_class` auto-stubs a cohort and the session still lands
- [ ] A stubbed cohort is countable as unresolved, like `unresolved_service`
- [ ] A `class_session` with no `session_link` row inserts cleanly (the portal-created
      case, allowed but unbuilt)
- [ ] A portal-native student (no `uid`) returns an **empty** schedule — not a
      fabricated one. WL cannot know them, and saying so is the correct answer
- [ ] Re-running the projection creates no duplicates
- [ ] Backfill cost measured and recorded, not estimated
- [ ] `git diff --stat src/` is empty for this task
- [ ] Mutation-tested: each trigger broken, suite goes red, restored
- [ ] DATA-MODEL.md and ARCHITECTURE.md updated in the same commit

## Constraints & notes

- `session` stores **local wall time as sent**, because WL's `text_timezone` is an
  abbreviation ("ET") that cannot be resolved to EST or EDT and Postgres cannot
  convert with it. That reasoning is in `0004` and carries over — do not try to
  re-derive local time from UTC in the projection.
- A class and a private appointment are one table in WL, distinguished by
  `session_kind`. Decide explicitly whether they stay one table here.
- WL list endpoints return keyed objects, not arrays.

## Resources

- `resources/` — empty. Source material is `supabase/migrations/0004`, `0012`,
  `docs/DATA-MODEL.md`, and `spin-dj-pathways/REQUIRED_APIS.md`.
