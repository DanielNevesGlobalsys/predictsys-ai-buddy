ALTER TABLE public.project_settings 
ADD COLUMN IF NOT EXISTS advanced_mode_enabled boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS target_mode_selected text DEFAULT NULL;