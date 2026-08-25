-- =============================================================================
-- 0017  session: check-in, the service, and the CANCELLATION DEADLINE
--
-- Adds what /v1/schedule/page/element returns per visit that 0004 and 0015 had
-- no column for. Probed live 25 Aug 2026.
--
-- dt_cancel_by IS NOT A CANCELLATION - READ THIS BEFORE USING IT
--   WL calls the field `dt_cancel`, and the obvious reading is "when this was
--   cancelled". It is not. Measured across 40 visits: it sat EXACTLY 24 hours
--   before the session start on 40 of 40, with no exceptions - including on
--   sessions that were attended. It is the studio's cancellation DEADLINE, the
--   moment after which a client can no longer cancel without penalty.
--
--   Stored under a name that says so. A column called dt_cancelled_at holding a
--   deadline would put a cancellation timestamp on every session in the
--   business, and every one of them would be wrong.
--
--   `session.dt_cancelled_studio_utc` (0004) is deliberately left alone: that
--   one really does mean "cancelled", and nothing on this endpoint fills it.
--
-- is_checkin
--   The client-side outcome: did the person actually turn up. False on every
--   future session, which is what it should be. This is the field the schedule
--   list cannot give - the list says a session exists, this says what happened.
--
-- k_service
--   Present on appointments, null on class bookings - so it doubles as part of
--   the shape discriminator. FK to service, which purchases already populate,
--   with a stub written first for anything not yet seen.
-- =============================================================================

alter table public.session
  add column if not exists is_checkin   boolean not null default false,
  add column if not exists k_service    text
    references public.service (k_service) on delete set null,
  add column if not exists dt_cancel_by timestamptz;

comment on column public.session.is_checkin is
  'Did the client actually turn up. From /v1/schedule/page/element, which is '
  'the only call that reports an outcome rather than a booking.';
comment on column public.session.dt_cancel_by is
  'The cancellation DEADLINE, not a cancellation. WL names it dt_cancel, but it '
  'was exactly 24h before start on 40 of 40 visits measured - including '
  'attended ones. For an actual cancellation see dt_cancelled_studio_utc.';
comment on column public.session.k_service is
  'Set on appointments, null on class bookings - part of how the two shapes are '
  'told apart.';

create index if not exists session_service_idx on public.session (k_service);
