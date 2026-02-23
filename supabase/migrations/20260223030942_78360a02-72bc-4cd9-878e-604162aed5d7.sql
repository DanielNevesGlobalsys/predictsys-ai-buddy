
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS weak_label_config jsonb DEFAULT NULL,
ADD COLUMN IF NOT EXISTS weak_label_result jsonb DEFAULT NULL;

COMMENT ON COLUMN public.project_settings.weak_label_config IS 'Weak supervision LF rules config, params, weights, thresholds';
COMMENT ON COLUMN public.project_settings.weak_label_result IS 'Weak supervision metrics: coverage, agreement, conflicts, prevalence, top_rules';
