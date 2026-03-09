
-- Add target_intent_resolution JSONB column to project_settings
-- This column stores the full resolution result from resolve-target-intent edge function
-- and is read by useIntentDrivenTarget hook and the target step UI
ALTER TABLE public.project_settings 
ADD COLUMN IF NOT EXISTS target_intent_resolution jsonb DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.project_settings.target_intent_resolution IS 
'Stores the full intent-driven target resolution result (candidates, strategy, confidence, entity, time anchor suggestions). Written by resolve-target-intent edge function, read by target step UI.';
