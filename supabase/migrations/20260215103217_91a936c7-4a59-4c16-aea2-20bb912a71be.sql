
-- Add last_run_status and error_message to monitoring SSOT
ALTER TABLE public.project_monitoring_state
  ADD COLUMN IF NOT EXISTS last_run_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS error_message text;
