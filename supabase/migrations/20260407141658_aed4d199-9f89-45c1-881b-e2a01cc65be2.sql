
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS official_target text,
  ADD COLUMN IF NOT EXISTS official_problem_type text,
  ADD COLUMN IF NOT EXISTS official_entity_key text,
  ADD COLUMN IF NOT EXISTS official_time_column text,
  ADD COLUMN IF NOT EXISTS official_grain text,
  ADD COLUMN IF NOT EXISTS recommended_target text,
  ADD COLUMN IF NOT EXISTS recommended_problem_type text,
  ADD COLUMN IF NOT EXISTS recommended_target_reasoning text,
  ADD COLUMN IF NOT EXISTS recommended_target_confidence numeric,
  ADD COLUMN IF NOT EXISTS governance_conflict boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS governance_conflict_details jsonb,
  ADD COLUMN IF NOT EXISTS last_governance_action text,
  ADD COLUMN IF NOT EXISTS last_governance_action_at timestamptz;
