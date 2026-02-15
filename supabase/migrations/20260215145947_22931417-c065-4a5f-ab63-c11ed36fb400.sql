
-- 1. Add indexes for batch-scoped operations
CREATE INDEX IF NOT EXISTS idx_predictions_project_batch ON public.predictions(project_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_predictions_batch ON public.predictions(batch_id);
CREATE INDEX IF NOT EXISTS idx_predictions_latest_project ON public.predictions(project_id) WHERE is_latest = true;

-- 2. Replace rpc_promote_prediction_batch with optimized version
CREATE OR REPLACE FUNCTION public.rpc_promote_prediction_batch(
  p_project_id uuid,
  p_batch_id text,
  p_model_id uuid DEFAULT NULL::uuid,
  p_selection_version integer DEFAULT NULL::integer,
  p_job_id uuid DEFAULT NULL::uuid,
  p_predictions_count integer DEFAULT 0,
  p_coverage_pct numeric DEFAULT 0,
  p_is_sanity_fail boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_demoted int := 0;
  v_promoted int := 0;
  v_batch_exists boolean;
  v_previous_batch_id text;
BEGIN
  -- Increase timeout for this transaction (5 minutes)
  PERFORM set_config('statement_timeout', '300000', true);

  -- Advisory lock scoped to project
  PERFORM pg_advisory_xact_lock(hashtext('pred_' || p_project_id::text));

  -- Validate batch belongs to this project
  SELECT EXISTS (
    SELECT 1 FROM public.predictions
    WHERE project_id = p_project_id AND batch_id = p_batch_id
    LIMIT 1
  ) INTO v_batch_exists;

  IF NOT v_batch_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'BATCH_NOT_FOUND',
      'message', format('batch_id=%s não encontrado para project_id=%s', p_batch_id, p_project_id)
    );
  END IF;

  -- Read previous batch from SSOT instead of scanning all rows
  SELECT latest_batch_id INTO v_previous_batch_id
  FROM public.project_prediction_state
  WHERE project_id = p_project_id;

  -- Demote ONLY the previous batch (not all is_latest=true rows)
  IF v_previous_batch_id IS NOT NULL AND v_previous_batch_id IS DISTINCT FROM p_batch_id THEN
    UPDATE public.predictions
    SET is_latest = false
    WHERE project_id = p_project_id AND batch_id = v_previous_batch_id AND is_latest = true;
    GET DIAGNOSTICS v_demoted = ROW_COUNT;
  END IF;

  -- Promote new batch
  UPDATE public.predictions
  SET is_latest = true
  WHERE project_id = p_project_id AND batch_id = p_batch_id AND is_latest = false;
  GET DIAGNOSTICS v_promoted = ROW_COUNT;

  -- Upsert prediction state (SSOT for dashboard)
  INSERT INTO public.project_prediction_state (
    project_id, latest_batch_id, latest_job_id, latest_model_id,
    latest_selection_version, status, predictions_count, coverage_pct,
    last_error_code, last_error_message, updated_at
  ) VALUES (
    p_project_id, p_batch_id, p_job_id, p_model_id,
    p_selection_version,
    CASE WHEN p_is_sanity_fail THEN 'sanity_fail' ELSE 'done' END,
    p_predictions_count, p_coverage_pct,
    CASE WHEN p_is_sanity_fail THEN 'SANITY_FAIL' ELSE NULL END,
    CASE WHEN p_is_sanity_fail THEN 'Previsões degeneradas' ELSE NULL END,
    now()
  )
  ON CONFLICT (project_id)
  DO UPDATE SET
    latest_batch_id = EXCLUDED.latest_batch_id,
    latest_job_id = EXCLUDED.latest_job_id,
    latest_model_id = EXCLUDED.latest_model_id,
    latest_selection_version = EXCLUDED.latest_selection_version,
    status = EXCLUDED.status,
    predictions_count = EXCLUDED.predictions_count,
    coverage_pct = EXCLUDED.coverage_pct,
    last_error_code = EXCLUDED.last_error_code,
    last_error_message = EXCLUDED.last_error_message,
    updated_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'latest_batch_id', p_batch_id,
    'previous_batch_id', v_previous_batch_id,
    'predictions_demoted', v_demoted,
    'predictions_promoted', v_promoted,
    'predictions_count', p_predictions_count
  );
END;
$function$;
