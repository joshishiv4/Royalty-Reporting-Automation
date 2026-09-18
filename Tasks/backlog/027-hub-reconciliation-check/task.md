---
id: 027
title: Hub reconciliation — prove the triggers are still working
status: backlog
priority: high
depends_on: [025]
created: 2026-09-17
---

# Hub reconciliation check and health view

## Goal

Task 025 makes the identity hub entirely trigger-maintained. That is the right
design — it cannot be forgotten by a future writer — but it has one bad failure
mode: **a trigger that silently stops firing looks exactly like nothing being
wrong.** Rows simply stop appearing, and no error is raised anywhere.

This task makes that failure visible.

## Scope

- A read-only script in `supabase/checks/` answering: is there a `person` with no
  `identity`? An `identity` with neither role and a known `k_login_type`? A role row
  pointing at no identity?
- A `data_health_issue` row for each, following the existing pattern
- The "role not yet known" count as a **first-class number**, not an error — task
  025 assumes stub people get an identity with the role deferred, and that number is
  the thing worth watching

## Out of scope

- Fixing drift automatically. The check reports; a human decides. Auto-repair on a
  count nobody has looked at hides the cause.

## Why this is its own task and not a line in 025

The check has to be able to fail. Written inside 025 it would be written by the same
reasoning that wrote the triggers, against the same assumptions, and would agree with
them. Written separately it is a second opinion.

## Acceptance criteria

- [ ] The check runs read-only and changes nothing
- [ ] Deliberately disabling each of the three triggers from 025 makes the check
      report drift — one at a time, all three proven
- [ ] Drift appears in `data_health_issue` alongside the existing rows
- [ ] "Role not yet known" is reported as a count, distinct from an error
- [ ] The check is referenced from RUNBOOK.md, with what to do when it is non-zero
- [ ] ARCHITECTURE.md lists the new file

## Constraints & notes

- Scripts that change nothing go in `supabase/checks/`; scripts that change something
  go in `scripts/`. This is the former.
- `data_health` and `data_health_issue` already exist (`0010`). Extend them; do not
  build a parallel health surface.
- Note the trap recorded in DATA-MODEL.md around `ghl_unresolved_since`: a timestamp
  rewritten by every retry cannot answer "how long has this been broken", and an
  alert built on one reports safety it does not have. Whatever timestamp this check
  leans on must not have that property.

## Resources

- `resources/` — empty. Pattern to follow: `supabase/migrations/0010`, the
  `data_health` and `data_health_issue` views.
