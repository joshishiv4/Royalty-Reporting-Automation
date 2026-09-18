# Progress: Session projection

## Checklist

- [ ] Decide whether a class and a private appointment stay one table here
- [ ] Design cohort_link, session_link, attendance_link, session_staff_link, class_session, attendance_record
- [ ] Confirm provenance reads off link presence alone, with no source column anywhere
- [ ] Verify WL-free by a test over the schema, not by reading it
- [ ] Cohort auto-stub from an unknown k_class, reusing the unresolved_service pattern
- [ ] Projection triggers: one direction, idempotent, backfill in the same migration
- [ ] Measure the backfill cost, and attendance_link growth, rather than assuming either
- [ ] Detect a portal-then-WL attendance collision instead of overwriting it
- [ ] End-to-end: a WL next session appears for that student
- [ ] Confirm a portal-native student gets an empty schedule
- [ ] Mutation-test each trigger, then update the docs in the same commit

## Last step

Not yet started.

## Blockers

None.

## Log

### 2026-09-17
- Task created.
