-- =============================================================================
-- 0019  session: bounding how often a visit's detail is re-read
--
-- Board item 7.3. The per-client pass (7.2) re-reads EVERY upcoming visit on
-- every run. Measured live: 22 list calls plus 115 detail calls = 137 per run,
-- and the detail half grows linearly with the client base. At a thousand clients
-- that is roughly six thousand calls a day against an API whose real rate limits
-- WellnessLiving has not told us. That is the problem this migration bounds.
--
-- THE RULE: AT MOST TWICE, THEN NEVER AGAIN
--   Once when the session is discovered (it is upcoming, nothing has happened
--   yet), and once after its date has passed and the outcome is final. A third
--   read cannot learn anything a second one did not.
--
-- WHY A COUNT AND A TIMESTAMP, NOT A BOOLEAN
--   "Fetched" would answer the wrong question. The pass needs to know both HOW
--   MANY times and WHEN LAST, because the second fetch is only useful after the
--   session start - fetching twice on the same day wastes the second read and
--   still leaves the outcome unknown.
--
-- THE IMMUTABILITY THRESHOLD
--   A session more than a week past its start is treated as settled and never
--   re-read, whatever the count says. Without that, a session that somehow never
--   reached two fetches would be retried forever, and the daily run would creep
--   back toward re-reading the whole history - the exact failure this bounds.
--   Seven days is deliberately generous: WellnessLiving allows cancellation up to
--   24 hours before, so an outcome is settled long before the week is out.
--
--   The threshold lives in code, not here, because it is a tuning decision and
--   changing a constant should not need a migration.
--
-- WHAT THIS DOES NOT SOLVE
--   PRD 7.3 also asks for a cancellation timestamp. The detail endpoint does not
--   carry one: its dt_cancel is a DEADLINE, measured at exactly 24 hours before
--   start on 40 of 40 visits, attended ones included (see 0017). is_checkin is
--   the only outcome WellnessLiving reports there. That criterion needs either a
--   different source or a rewrite; it is not satisfiable from this endpoint.
--
-- Safe to re-run.
-- =============================================================================

alter table public.session
  add column if not exists detail_fetch_count integer     not null default 0,
  add column if not exists detail_fetched_at  timestamptz;

comment on column public.session.detail_fetch_count is
  'How many times the visit detail has been read. Capped at two by the pass: '
  'once on discovery, once after the session has happened.';
comment on column public.session.detail_fetched_at is
  'When the detail was last read. Needed as well as the count, because the '
  'second read is only worth making after the session start.';

-- The seed asks "which sessions still need a detail read", which is a scan over
-- the count and the start time together.
create index if not exists session_detail_pending_idx
  on public.session (k_business, detail_fetch_count, dt_start_utc);
