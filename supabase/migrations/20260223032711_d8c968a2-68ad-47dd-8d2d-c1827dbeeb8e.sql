
-- Add target lifecycle columns to project_settings
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS target_lifecycle_state JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS target_last_validated_at TIMESTAMPTZ;
