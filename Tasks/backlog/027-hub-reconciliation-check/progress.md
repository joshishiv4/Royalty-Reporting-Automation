# Progress: Hub reconciliation

## Checklist

- [ ] Write the read-only check in supabase/checks/
- [ ] Extend data_health_issue rather than building a parallel health surface
- [ ] Report role-not-yet-known as a count, not an error
- [ ] Disable each of the three triggers in turn and confirm the check reports drift
- [ ] Check the timestamp it leans on cannot read as fresh after a retry
- [ ] Document the non-zero response in RUNBOOK.md, and list the file in ARCHITECTURE.md

## Last step

Not yet started.

## Blockers

None.

## Log

### 2026-09-17
- Task created.
