-- =============================================================================
-- 0022  person: when the GoHighLevel match was last attempted
--
-- Board item M04 follow-on. The criteria are that a resolved client is never
-- re-queried, that only unmatched and ambiguous clients are eligible for a
-- retry, and that retrying is a DELIBERATE action rather than something the
-- daily run does on its own.
--
-- THE GAP THIS COLUMN CLOSES
--   'unmatched' is the default state. So a client who has never been searched
--   for and a client who WAS searched for and genuinely is not in GoHighLevel
--   look identical. Without telling them apart there is no way to satisfy both
--   "match new clients automatically" and "retrying unmatched is manual" - the
--   two rules contradict each other on the same rows.
--
--   ghl_match_attempted_at null  -> never searched. The automatic pass takes it.
--   ghl_match_attempted_at set   -> searched already. Only a deliberate retry
--                                   touches it, and only if it is unresolved.
--
-- WHY A TIMESTAMP AND NOT A BOOLEAN
--   "When did we last look" is the question anyone actually asks of an unmatched
--   client, and it is the question a retry decision turns on - a search from
--   before the contact existed in GoHighLevel is worth repeating, one from an
--   hour ago is not. A boolean answers neither.
--
-- WHAT COUNTS AS RESOLVED
--   'matched' only. An id is stored, the link is usable, and nothing re-queries
--   it - which is what keeps this integration's ongoing cost at effectively
--   zero. 'ambiguous' is unresolved but waiting on a HUMAN, not on us.
--   'failed' is unresolved for a data reason (a contact carrying no id) and is
--   retryable for the same reason ambiguous is: leaving it permanently
--   ineligible would strand the row with no route back, which no criterion asks
--   for and nobody would ever notice.
--
-- Safe to re-run.
-- =============================================================================

alter table public.person
  add column if not exists ghl_match_attempted_at timestamptz;

comment on column public.person.ghl_match_attempted_at is
  'When the GoHighLevel match was last attempted. NULL means never searched, '
  'which is the only thing the automatic pass picks up - a client already '
  'searched for is retried only by deliberate request.';

-- The automatic seed asks exactly one question: who has never been searched for?
create index if not exists person_ghl_never_attempted_idx
  on public.person (k_business)
  where ghl_match_attempted_at is null;

-- The manual retry asks a different one: who is unresolved and worth another go?
create index if not exists person_ghl_unresolved_idx
  on public.person (k_business, ghl_match_state)
  where ghl_match_state <> 'matched';

-- -----------------------------------------------------------------------------
-- Backfill: everyone already carrying a verdict has, by definition, been
-- attempted. Without this the first run after deploy would re-search all of
-- them - the precise behaviour these criteria exist to prevent.
--
-- now() rather than a guess at the original time: it is the honest answer to
-- "when do we know it had been attempted by", and inventing a past timestamp
-- would be worse than an approximate present one.
-- -----------------------------------------------------------------------------
update public.person
   set ghl_match_attempted_at = now()
 where ghl_match_attempted_at is null
   and (ghl_match_state <> 'unmatched' or ghl_contact_id is not null);
