# CLAUDE.md

Deliberately short. The detail lives in `docs/` — duplicate it here and the two
copies will disagree.

## Read first

| Question | Doc |
|---|---|
| How do I run it? | [README.md](README.md) |
| Where is X defined? | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Why is the schema like this? | [docs/DATA-MODEL.md](docs/DATA-MODEL.md) |
| What's built, what's blocked? | [docs/STATUS.md](docs/STATUS.md) |
| How does the WL/GHL API actually behave? | [docs/WL-API-NOTES.md](docs/WL-API-NOTES.md) |
| Credentials and rotation | [docs/RUNBOOK.md](docs/RUNBOOK.md) |

## Rules that are easy to break by accident

**Success comes from the response body, never the HTTP status.** WellnessLiving
answers 200 for errors. All data calls go through `WlClient.request()`, which
asserts `status === "ok"`. A structural test fails the build if any module outside
the client calls `fetch` itself.

**Money is `numeric(12,2)`. Never float.** WL sends `"280.00"` as a string.

**All WellnessLiving keys are `text`.** `uid`, `k_staff`, `k_purchase` and friends
arrive as strings. As integers a leading zero is lost.

**Hosts never appear in source, logs, or stored records.** A host is configuration.
`tests/no-hardcoded-config.test.ts` enforces this.

**Credentials are redacted once, before the logger fans out to sinks.** Never format
a log payload inside a sink — that is how a scrubbed secret gets reintroduced.

**`dt_date` needs a time component.** `2026-08-19` fails; `2026-08-19 00:00:00`
works. Silent trap.

**WL list endpoints return keyed objects, not arrays.** Iterate with
`Object.values()`.

## Before adding a table

Read [docs/DATA-MODEL.md](docs/DATA-MODEL.md) first — several obvious-looking designs
were tried and rejected for measured reasons. In particular: one human is one
`person` row, the purchase **item** is the royalty row, and `text_login_type` never
identifies a teacher.

Migrations live in `supabase/migrations/`, numbered, self-contained, safe to re-run.
Verification scripts that change nothing go in `supabase/checks/`.

## Keeping the docs true

The docs are load-bearing here, not decoration — several decisions in this project
were made once, for measured reasons, and the only record of why is in `docs/`. A
doc that has drifted is worse than a missing one, because it gets believed.

**Update the doc in the SAME commit as the change.** A follow-up commit is a
follow-up commit that does not happen.

| If you change | Update |
|---|---|
| Add, move or delete a file in `src/` or `api/` | the file tables in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| The sync flow, or the order things happen in | "How a sync pass runs" in ARCHITECTURE.md |
| A module's responsibility, or add a directory | the module map in ARCHITECTURE.md |
| A migration, table, column or view | [docs/DATA-MODEL.md](docs/DATA-MODEL.md), and the migration table in ARCHITECTURE.md |
| Discover how WL or GHL actually behaves | [docs/WL-API-NOTES.md](docs/WL-API-NOTES.md) |
| Finish something, or hit a new blocker | [docs/STATUS.md](docs/STATUS.md) — **and its date** |
| A convention everyone must follow | this file, and the conventions section of ARCHITECTURE.md |
| Anything about credentials or rotation | [docs/RUNBOOK.md](docs/RUNBOOK.md) |

**Every file under `src/` and `api/` must be named in ARCHITECTURE.md, and every
migration must appear in its migration table.** This is enforced —
[tests/docs-current.test.ts](tests/docs-current.test.ts) fails the build on an
unregistered file, so a new module cannot land undocumented.

If a file genuinely needs no explanation, one line in the nearest table is still the
answer. "Where is X defined" should never require grep.

**Record the reasoning, not just the shape.** `raw_link` exists because a single
column recorded half of where a purchase came from; `numeric(12,2)` exists because
WL sends money as strings. Anyone can read the DDL — what they cannot recover is why
the obvious alternative was rejected. When a measurement drove a decision, quote it.

## Testing

`npm run verify` = format, lint, typecheck, tests.

A test that cannot fail is not a test. Behaviour here is verified by mutation —
break the thing deliberately, confirm the suite goes red, restore. If you add a
guarantee, prove the test catches its absence.

## Working style

Explain the plan before writing code, and wait for a go-ahead. Investigation,
reading, running tests and probing live APIs need no approval; writing files does.

State what is blocked rather than guessing around it. Several things in this project
genuinely cannot be built yet — see the blocked section of
[docs/STATUS.md](docs/STATUS.md) — and inventing a plausible substitute would be
worse than leaving them null and saying so.

## Complex or long tasks: write a PRD first

Anything that spans more than one sitting, more than a few files, or has no obvious
single answer goes through the `task-manager` skill (`.claude/skills/task-manager/`)
before code is written. Tasks live in `Tasks/`; conventions are in
[Tasks/README.md](Tasks/README.md).

**Answer from the codebase before asking a human.** If the goal, scope or acceptance
criteria are already recorded — in `docs/`, a migration, a test, or the code itself —
read it. A question whose answer was already written down costs the user a round trip
and teaches them their docs are not being read.

**Interview only for what the repo cannot answer**, and keep going until the goal is
genuinely clear — not until the first plausible reading appears. Scope and acceptance
criteria are what get guessed at; a wrong guess there is discovered at review, after
the work is done. Then write the PRD into the task and get it confirmed before
starting.

For a task that is small and unambiguous, skip all of this. A ticket for a one-line
fix is overhead, and overhead is what stops the system being used at all.
