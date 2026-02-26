
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS derived_target_plan jsonb DEFAULT NULL,
ADD COLUMN IF NOT EXISTS time_anchor_col text DEFAULT NULL;
