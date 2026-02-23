
-- Add target_source tracking columns to project_settings
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS target_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS selected_template_id text,
  ADD COLUMN IF NOT EXISTS selected_template_params jsonb;

-- Add comment for clarity
COMMENT ON COLUMN public.project_settings.target_source IS 'manual or label_builder';
COMMENT ON COLUMN public.project_settings.selected_template_id IS 'Template ID when target_source=label_builder';
COMMENT ON COLUMN public.project_settings.selected_template_params IS 'Template params when target_source=label_builder';
