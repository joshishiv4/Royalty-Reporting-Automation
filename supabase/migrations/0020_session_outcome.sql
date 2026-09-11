-- =============================================================================
-- 0020  session_outcome - what actually happened, derived in ONE place
--
-- Board item 7.4. Nothing in WellnessLiving carries a single "attendance status"
-- field, so the outcome has to be derived. The point of a view is that the rule
-- lives HERE and nowhere else: every job, report and portal query reads the same
-- derivation, and changing it is one statement rather than a hunt through the
-- codebase. A stored column would be worse - it would go stale the moment a
-- session's date passes without anything writing to it.
--
-- WHAT THE TICKET ASSUMED, AND WHAT IS ACTUALLY THERE
--   7.4 describes four outcomes derived from three inputs: a cancellation
--   timestamp, a check-in flag, and the session date. The cancellation timestamp
--   DOES NOT EXIST. WL's `dt_cancel` looks like one and is not: measured across
--   40 visits it sat exactly 24 hours before the session start on 40 of 40,
--   including sessions that were attended. It is the cancel-by deadline, stored
--   as dt_cancel_by (see 0017), and reading it as a cancellation would mark every
--   session in the business cancelled.
--
--   So `client_cancelled` is NOT produced here. WL reports nothing that means
--   "this client cancelled their place" - not on the visit detail, not on
--   visit/status (which reports whether cancelling is still ALLOWED), and not on
--   the attendance list. An outcome nobody can substantiate is worse than a
--   missing one, so it is absent rather than guessed.
--
-- WHAT REPLACED THE DERIVATION
--   The ticket derives "missed" from "date passed and no check-in". WL answers
--   that directly - `is_truancy`, stored as attendance.is_no_show - so this asks
--   rather than infers. Inference would silently disagree with WL the moment a
--   studio marks someone absent without the date logic agreeing.
--
-- THE NAMING TRAP, WHICH 0004 ALREADY AVOIDED
--   A cancellation on the SESSION is the studio pulling the class; a cancellation
--   on the BOOKING is one client dropping out. They are different events with
--   different royalty consequences and they live in different columns -
--   session.is_cancelled_studio and attendance.is_cancelled_client. This view
--   keeps them apart: a studio cancellation resolves to 'studio_cancelled' for
--   everyone booked, and never touches the client's own record.
--
-- WHY 'unknown' EXISTS AND IS NOT A FAILURE
--   A session whose date has passed, that the studio did not cancel, and which WL
--   reports as neither attended nor a no-show, is genuinely unknown. That is the
--   shape of Q9 - "is check-in used consistently for private lessons" - made
--   countable. If this bucket is large, the missed rule is unsafe for royalties
--   and the answer is in the data rather than in an opinion. Folding these into
--   'missed' would destroy exactly the evidence the question needs.
--
-- Safe to re-run.
-- =============================================================================

drop view if exists public.session_outcome;

create view public.session_outcome
  with (security_invoker = on) as
  select
    a.k_period,
    a.dt_start_utc,
    a.uid,
    a.k_business,
    a.k_visit,
    s.session_kind,
    s.text_title,
    s.dtl_start_local,
    s.text_timezone,

    -- The inputs, carried alongside the verdict so a surprising outcome can be
    -- argued with rather than merely disbelieved.
    s.is_cancelled_studio,
    a.is_cancelled_client,
    a.is_attended,
    a.is_no_show,
    a.is_waitlisted,
    a.is_unpaid,
    s.is_checkin,
    s.dt_cancel_by,

    case
      -- Studio first: it overrides everything below. A class the studio pulled
      -- was not missed by anyone, and nobody is owed a royalty for it.
      when s.is_cancelled_studio then 'studio_cancelled'
      -- Kept for completeness. Nothing WL returns sets this today (see header);
      -- the branch exists so that when a source is found, one line changes.
      when a.is_cancelled_client then 'client_cancelled'
      -- Someone queued for a place was never in the class.
      when a.is_waitlisted then 'waitlisted'
      -- WL's own answers, preferred over anything we could infer.
      when a.is_attended then 'attended'
      when a.is_no_show then 'missed'
      -- Not yet happened. Deliberately AFTER the WL answers: a studio can mark
      -- attendance early, and that is a fact, not a contradiction.
      when s.dt_start_utc > now() then 'upcoming'
      -- Happened, not cancelled, and WL says nothing. This is Q9, counted.
      else 'unknown'
    end as outcome

  from public.attendance a
  join public.session s
    on s.k_period = a.k_period
   and s.dt_start_utc = a.dt_start_utc;

comment on view public.session_outcome is
  'What happened to each booking, derived in ONE place. Note there is no '
  'client_cancelled in practice: WL reports no client cancellation anywhere, '
  'and its dt_cancel is a DEADLINE not a cancellation (0017). "unknown" counts '
  'sessions that happened with no WL verdict - that is Q9 made measurable.';
