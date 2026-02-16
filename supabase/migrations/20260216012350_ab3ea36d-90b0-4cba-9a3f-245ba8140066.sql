
-- Add last_heartbeat_at to project_prediction_state for stale lock detection
ALTER TABLE public.project_prediction_state 
ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamp with time zone DEFAULT now();

-- Backfill existing rows
UPDATE public.project_prediction_state 
SET last_heartbeat_at = COALESCE(updated_at, now()) 
WHERE last_heartbeat_at IS NULL;
