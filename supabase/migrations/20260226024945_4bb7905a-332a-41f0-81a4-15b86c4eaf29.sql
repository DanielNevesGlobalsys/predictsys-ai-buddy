
-- Add pipeline runner columns to project_settings
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS last_pipeline_stage text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_pipeline_state text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_pipeline_meta jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS active_run_id text DEFAULT NULL;

-- Create or replace rpc_set_pipeline_state
CREATE OR REPLACE FUNCTION public.rpc_set_pipeline_state(
  p_project_id uuid,
  p_stage text,
  p_state text,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_col text;
  v_valid_stages text[] := ARRAY['ingestion','eda','target','split','builder','training','scoring','dashboard'];
BEGIN
  -- Update last_pipeline_* always
  UPDATE public.project_settings
  SET last_pipeline_stage = p_stage,
      last_pipeline_state = p_state,
      last_pipeline_meta = p_meta,
      updated_at = now()
  WHERE project_id = p_project_id;

  -- Also update the specific *_state column if valid
  IF p_stage = ANY(v_valid_stages) THEN
    v_col := p_stage || '_state';
    EXECUTE format('UPDATE public.project_settings SET %I = $1, updated_at = now() WHERE project_id = $2', v_col)
    USING p_state, p_project_id;
  END IF;

  -- Insert platform_event
  INSERT INTO public.platform_events (event_type, project_id, status, source, metadata)
  VALUES ('pipeline_state_changed', p_project_id, 'info', 'edge',
    jsonb_build_object('stage', p_stage, 'state', p_state) || p_meta
  );

  RETURN jsonb_build_object('success', true, 'stage', p_stage, 'state', p_state);
END;
$$;
