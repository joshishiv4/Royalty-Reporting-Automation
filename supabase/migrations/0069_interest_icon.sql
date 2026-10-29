-- Cache of LLM-assigned icons for interest tags.
--
-- The "Things I'm Into" section on the student home card renders an icon per
-- tag. Tags are free text inferred by the LLM from quiz answers, so the icon
-- cannot be hardcoded. Instead, the quiz-attempt handler asks the model to pick
-- an icon from the registry and upserts the (tag, icon) pair here. The
-- interests API reads this table so that the same tag always shows the same
-- icon, across students and across sessions.
--
-- No RLS policy: students never query this table directly. The interests API
-- reads it via the service role; the quiz-attempt handler writes it the same
-- way.

create table if not exists app.interest_icon (
  id         uuid        primary key default gen_random_uuid(),
  tag        text        not null unique,  -- lowercased interest name
  icon       text        not null,         -- icon registry key (e.g. 'superhero', 'gaming')
  created_at timestamptz not null default now()
);

comment on table app.interest_icon is
  'Cache of LLM-assigned icons for interest tags. One row per unique '
  'lowercased tag. Written by the quiz-attempt handler when a new tag '
  'appears; read by the interests API.';
