
-- Add active_target columns to project_settings SSOT
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS active_target_mode TEXT DEFAULT 'column',
  ADD COLUMN IF NOT EXISTS active_target_column TEXT,
  ADD COLUMN IF NOT EXISTS active_target_ref JSONB,
  ADD COLUMN IF NOT EXISTS active_target_updated_at TIMESTAMPTZ;

-- Backfill existing projects based on current state
UPDATE public.project_settings
SET
  active_target_mode = CASE
    WHEN target_source = 'human_labeling' OR (human_label_result IS NOT NULL AND (human_label_result->>'n_labeled')::int > 0 AND target_source = 'human_labeling') THEN 'human'
    WHEN target_source = 'weak_supervision' AND weak_label_result IS NOT NULL THEN 'weak'
    WHEN selected_template_id IS NOT NULL AND target_source = 'label_builder' THEN 'template'
    ELSE 'column'
  END,
  active_target_column = CASE
    WHEN target_source = 'human_labeling' THEN NULL
    WHEN target_source = 'weak_supervision' THEN NULL
    ELSE target_column
  END,
  active_target_ref = CASE
    WHEN target_source = 'human_labeling' AND human_label_result IS NOT NULL THEN
      jsonb_build_object('human_label_result_id', COALESCE(human_label_result->>'round_id', 'legacy'), 'source', 'human_labeling')
    WHEN target_source = 'weak_supervision' AND weak_label_result IS NOT NULL THEN
      jsonb_build_object('weak_label_job_id', 'legacy', 'source', 'weak_supervision')
    WHEN selected_template_id IS NOT NULL AND target_source = 'label_builder' THEN
      jsonb_build_object('label_builder_id', selected_template_id, 'source', 'label_builder')
    ELSE NULL
  END,
  active_target_updated_at = COALESCE(updated_at, now())
WHERE active_target_mode IS NULL OR active_target_mode = 'column';

-- Add comment for documentation
COMMENT ON COLUMN public.project_settings.active_target_mode IS 'Logical enum: column | template | human | weak. Determines how the training target is resolved.';
COMMENT ON COLUMN public.project_settings.active_target_column IS 'Only set when mode is template or column. NULL when mode is human or weak.';
COMMENT ON COLUMN public.project_settings.active_target_ref IS 'Reference to the artifact used for target (human_label_result_id, label_builder_id, weak_label_job_id).';
