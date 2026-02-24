-- Add split_validation_log column to project_settings for SSOT persistence
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS split_validation_log JSONB NOT NULL DEFAULT '{}'::jsonb;