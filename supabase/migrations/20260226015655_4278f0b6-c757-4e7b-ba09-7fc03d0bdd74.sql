ALTER TABLE public.project_settings 
ADD COLUMN IF NOT EXISTS modeling_dataset_meta jsonb DEFAULT NULL;