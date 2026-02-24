
-- Add target_trainability_report to project_settings for SSOT persistence
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS target_trainability_report JSONB DEFAULT NULL;

COMMENT ON COLUMN public.project_settings.target_trainability_report IS 'Canonical target trainability diagnostic: {trainable, reason_code, details, fix_suggestions}';
