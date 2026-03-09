
ALTER TABLE public.project_settings 
  ADD COLUMN IF NOT EXISTS lys_insight_text text,
  ADD COLUMN IF NOT EXISTS lys_recommendation_json jsonb,
  ADD COLUMN IF NOT EXISTS lys_confidence_score numeric,
  ADD COLUMN IF NOT EXISTS lys_synthesized_at timestamptz;
