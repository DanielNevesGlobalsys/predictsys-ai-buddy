
-- Add dataset_ready_for_modeling flag to projects table
ALTER TABLE public.projects 
  ADD COLUMN IF NOT EXISTS dataset_ready_for_modeling boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS dataset_blocked_reason text DEFAULT NULL;
