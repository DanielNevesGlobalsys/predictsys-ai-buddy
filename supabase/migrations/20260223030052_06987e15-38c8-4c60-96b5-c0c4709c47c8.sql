ALTER TABLE public.project_settings 
ADD COLUMN IF NOT EXISTS target_quality_report jsonb DEFAULT NULL;

COMMENT ON COLUMN public.project_settings.target_quality_report IS 'Target Quality Validator report: quality_score, leakage detection, stability, coverage, gates';
