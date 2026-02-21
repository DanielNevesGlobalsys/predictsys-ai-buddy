
-- 1) Drop ALL existing overloads of rpc_promote_prediction_batch
DROP FUNCTION IF EXISTS public.rpc_promote_prediction_batch(uuid, text, uuid, integer, uuid, integer, numeric, boolean);
DROP FUNCTION IF EXISTS public.rpc_promote_prediction_batch(uuid, text, uuid, integer, text, integer, numeric, boolean);
DROP FUNCTION IF EXISTS public.rpc_promote_prediction_batch(uuid, text, integer, numeric);

-- 2) Create new O(1) version — NEVER touches predictions table
CREATE OR REPLACE FUNCTION public.rpc_promote_prediction_batch(
  p_project_id uuid,
  p_batch_id text,
  p_predictions_count integer DEFAULT NULL,
  p_coverage_pct numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_current_batch text;
BEGIN
  -- Advisory lock scoped to project (released at end of transaction)
  PERFORM pg_advisory_xact_lock(hashtext('pred_' || p_project_id::text));

  -- Check current state
  SELECT latest_batch_id INTO v_current_batch
  FROM public.project_prediction_state
  WHERE project_id = p_project_id;

  -- Already promoted?
  IF v_current_batch IS NOT NULL AND v_current_batch = p_batch_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'ALREADY_PROMOTED',
      'project_id', p_project_id,
      'batch_id', p_batch_id
    );
  END IF;

  -- O(1) upsert — only touches project_prediction_state
  INSERT INTO public.project_prediction_state (
    project_id, latest_batch_id, status,
    predictions_count, coverage_pct,
    last_error_code, last_error_message,
    updated_at, last_heartbeat_at
  ) VALUES (
    p_project_id, p_batch_id, 'done',
    COALESCE(p_predictions_count, 0),
    COALESCE(p_coverage_pct, 0),
    NULL, NULL,
    now(), now()
  )
  ON CONFLICT (project_id)
  DO UPDATE SET
    latest_batch_id = EXCLUDED.latest_batch_id,
    status = 'done',
    predictions_count = COALESCE(EXCLUDED.predictions_count, project_prediction_state.predictions_count),
    coverage_pct = COALESCE(EXCLUDED.coverage_pct, project_prediction_state.coverage_pct),
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = now(),
    last_heartbeat_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'status', 'PROMOTED',
    'project_id', p_project_id,
    'batch_id', p_batch_id
  );
END;
$function$;

-- 3) Indices for performance
CREATE INDEX IF NOT EXISTS idx_predictions_project_batch
ON public.predictions(project_id, batch_id);

CREATE INDEX IF NOT EXISTS idx_prediction_state_project
ON public.project_prediction_state(project_id);

-- 4) Refresh statistics
ANALYZE public.predictions;
ANALYZE public.project_prediction_state;
