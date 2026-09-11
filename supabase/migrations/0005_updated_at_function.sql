-- =============================================================================
-- 0005  the updated_at trigger function
--
-- Every table gets created_at and updated_at (0006). Both are timestamptz, which
-- IS UTC: Postgres stores a timestamptz as an absolute instant and renders it in
-- whatever timezone the reading session asks for. There is no second copy to
-- drift out of step.
--
-- WHY A TRIGGER AND NOT JUST A DEFAULT
-- `updated_at timestamptz default now()` fires once, at INSERT, and never again.
-- A column defended only by a default therefore reports the CREATION time for
-- the rest of its life, and every "what changed since yesterday" query built on
-- it is quietly wrong - wrong in the direction that looks fine, because the
-- column is populated and plausible.
--
-- Putting it in the database rather than in the sync code means it also holds
-- for a backfill script, a manual correction in the Supabase dashboard, and
-- anything written by a future service that nobody has thought of yet.
--
-- Split into its own migration because it is shared by every table in 0006 and
-- must exist before any of those triggers can be created.
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

comment on function public.set_updated_at() is
  'Sets updated_at on every UPDATE. A default alone only fires at INSERT, which '
  'would leave updated_at frozen at the creation time forever.';
