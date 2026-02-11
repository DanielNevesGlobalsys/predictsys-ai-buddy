
-- Add EDA readiness fields to import_manifests
ALTER TABLE public.import_manifests
  ADD COLUMN IF NOT EXISTS eda_ready boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS model_ready boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS eda_strategy text DEFAULT 'UNION_BY_NAME',
  ADD COLUMN IF NOT EXISTS eda_scope text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS eda_dataset_id uuid DEFAULT NULL REFERENCES public.project_datasets(id),
  ADD COLUMN IF NOT EXISTS model_dataset_id uuid DEFAULT NULL REFERENCES public.project_datasets(id),
  ADD COLUMN IF NOT EXISTS blocked_reason_eda text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS blocked_reason_model text DEFAULT NULL;
