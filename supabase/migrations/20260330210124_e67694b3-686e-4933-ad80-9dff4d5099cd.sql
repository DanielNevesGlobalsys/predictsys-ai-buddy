
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS recommended_grain text,
  ADD COLUMN IF NOT EXISTS grain_confidence numeric,
  ADD COLUMN IF NOT EXISTS recommended_time_column text,
  ADD COLUMN IF NOT EXISTS time_strategy_confidence numeric,
  ADD COLUMN IF NOT EXISTS recommended_split_strategy text,
  ADD COLUMN IF NOT EXISTS dataset_build_mode text,
  ADD COLUMN IF NOT EXISTS temporal_readiness_state text;
