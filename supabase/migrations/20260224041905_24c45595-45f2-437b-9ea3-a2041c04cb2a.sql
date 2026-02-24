-- Add contract metadata columns to project_settings SSOT
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS contract_version INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS contract_generated_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.project_settings.contract_version IS 'Version of the current intent contract synced from generate-intent-contract';
COMMENT ON COLUMN public.project_settings.contract_generated_at IS 'Timestamp when the current intent contract was generated';