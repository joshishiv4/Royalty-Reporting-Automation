-- =============================================================================
-- 0027  Whether a client is activated in WellnessLiving
--
-- The client-list report used to pull only activated clients (o_member_status
-- [3]): 517 of them, against 1,285 across every status. We now store EVERYONE,
-- so a column is needed to say which of them WL still considers activated.
--
-- WHY A BOOLEAN, AND NOT WL's member_status CODE
--   WL does not expose a per-row status on this report - the row carries a client
--   TYPE ("Cancelled Client", "SDC Client", ...) but no activated/deactivated
--   field. And the o_member_status FILTER only distinguishes one value: measured
--   26 Aug 2026, [3] returns 517 (the portal's "Activated"), while [1] and [2]
--   are ignored and return all 1,285. So "activated" is the only status the API
--   can actually tell us, and a boolean is the honest shape. is_active is set by
--   membership of the [3] result, not read from a field that does not exist.
--
-- WHY NOT text_login_type
--   Type is not status. "Inactive Client" and "SDC Client" both appear among the
--   activated 517 AND among the deactivated remainder - measured. Deriving active
--   from the type label would misclassify thousands of clients.
--
-- Nullable on purpose: null means "status unknown", which is the honest state for
-- a person who reached the table as a purchase payer/recipient stub and has not
-- yet been seen in the client-list report. The report sets true/false; nothing
-- else touches it.
--
-- Safe to re-run.
-- =============================================================================

alter table public.person
  add column if not exists is_active boolean;

comment on column public.person.is_active is
  'True when WellnessLiving lists this client as activated (report o_member_status '
  '3), false when the client-list report returned them under any other status, '
  'null when they have not yet appeared in that report (e.g. a purchase-only '
  'stub). NOT derived from text_login_type - type is not status.';

-- Reading "the clients we would actually bill" without scanning the deactivated
-- majority (713 cancelled + 22 garbage out of 1,285).
create index if not exists person_is_active_idx
  on public.person (k_business, is_active);
