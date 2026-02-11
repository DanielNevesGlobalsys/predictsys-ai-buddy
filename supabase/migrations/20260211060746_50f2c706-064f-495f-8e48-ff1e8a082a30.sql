
-- Add deploy tracking columns to project_models
ALTER TABLE public.project_models
  ADD COLUMN IF NOT EXISTS deployed_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deployed_selection_version integer DEFAULT NULL;

-- Add production_model_id to project_dataset_state
ALTER TABLE public.project_dataset_state
  ADD COLUMN IF NOT EXISTS production_model_id uuid DEFAULT NULL;

-- Add FK constraint
ALTER TABLE public.project_dataset_state
  ADD CONSTRAINT fk_production_model
  FOREIGN KEY (production_model_id)
  REFERENCES public.project_models(id)
  ON DELETE SET NULL;
