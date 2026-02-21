
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
  v_current_status text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pred_' || p_project_id::text));

  SELECT latest_batch_id, status INTO v_current_batch, v_current_status
  FROM public.project_prediction_state
  WHERE project_id = p_project_id;

  -- Already promoted — ensure status is 'done' (idempotent fix)
  IF v_current_batch IS NOT NULL AND v_current_batch = p_batch_id THEN
    IF v_current_status IS DISTINCT FROM 'done' THEN
      UPDATE public.project_prediction_state
      SET status = 'done', last_error_code = NULL, last_error_message = NULL,
          updated_at = now(), last_heartbeat_at = now()
      WHERE project_id = p_project_id;
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'status', 'ALREADY_PROMOTED',
      'project_id', p_project_id,
      'batch_id', p_batch_id
    );
  END IF;

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
