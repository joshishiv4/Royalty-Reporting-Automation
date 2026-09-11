-- =============================================================================
-- 0016  attendance: waitlisted, unpaid, and who did the booking
--
-- 0004 modelled attendance before anything could fetch it, so it guessed at the
-- outcome fields. Probed live 25 Aug 2026 across every stored session,
-- /v1/login/attendance/list returns three separate lists per occurrence -
-- a_list_active, a_list_confirm and a_list_wait - and each attendee carries
-- is_visit / is_attend, is_truancy, is_wait, is_unpaid, is_penalty, is_free,
-- is_early, dt_book, uid_book and k_visit.
--
-- Most of that already maps onto 0004. Three facts had nowhere to go:
--
-- is_waitlisted
--   A person on a_list_wait is NOT booked into the session - they are queued for
--   a place. Storing them with the booked attendees and no flag would count a
--   hopeful as a head, and capacity reporting would quietly overstate. Observed
--   0 waitlisted on dev, which is exactly when a flag is cheap to add and
--   expensive to retrofit.
--
-- is_unpaid
--   Live, this is TRUE on ten of the twelve attendee records - every future
--   booking on dev is unpaid. A royalty on an unpaid booking is not the same
--   claim as a royalty on a paid one, and the difference is not recoverable from
--   the purchase side, because a booking need never become a purchase.
--
-- uid_book
--   Who made the booking, which is NOT who attends. Live, every one of the
--   twelve was booked by a single staff account while the attendees are two
--   different clients. Without it, "who sold this" has no answer on the schedule
--   side at all - the same gap the purchase side has (see WL-API-NOTES).
--
-- WHY uid_book HAS NO FOREIGN KEY
--   The booker is often staff, and staff arrive from a different endpoint on a
--   different schedule. A hard FK would reject a whole attendance batch because
--   a booking clerk had not synced yet - exactly the save-don't-fail case
--   raw_link and service.is_resolved already exist for.
--
-- Safe to re-run.
-- =============================================================================

alter table public.attendance
  add column if not exists is_waitlisted boolean not null default false,
  add column if not exists is_unpaid     boolean not null default false,
  add column if not exists uid_book      text;

comment on column public.attendance.is_waitlisted is
  'Queued for a place rather than booked into it - WL''s a_list_wait. Counted '
  'separately from attendees so capacity reporting cannot overstate.';
comment on column public.attendance.is_unpaid is
  'WL''s is_unpaid. True on ten of twelve records live: a booking that has not '
  'been paid for is a different royalty claim from one that has.';
comment on column public.attendance.uid_book is
  'Who made the booking, which is not who attends - deliberately no FK, because '
  'a booking clerk who has not synced yet must not reject the whole batch.';

-- Attendance is read per person ("what did this client attend") as often as it
-- is read per session, and the primary key only serves the latter.
create index if not exists attendance_uid_idx on public.attendance (uid);
