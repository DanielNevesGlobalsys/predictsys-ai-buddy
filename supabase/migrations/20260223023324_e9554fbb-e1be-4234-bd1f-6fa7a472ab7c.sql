-- Add label_build_result JSONB column to project_settings for SSOT persistence
-- This stores the full result of label generation including gates, stats, and reproducibility info
ALTER TABLE public.project_settings 
ADD COLUMN IF NOT EXISTS label_build_result jsonb DEFAULT NULL;