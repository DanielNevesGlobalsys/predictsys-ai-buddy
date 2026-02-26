ALTER TABLE public.project_settings 
  ADD COLUMN IF NOT EXISTS eda_profile_json jsonb,
  ADD COLUMN IF NOT EXISTS eda_profile_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS eda_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS eda_error text;