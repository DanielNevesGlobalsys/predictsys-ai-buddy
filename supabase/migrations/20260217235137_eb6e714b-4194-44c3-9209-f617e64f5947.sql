
-- 1) Add indexes for batch_id filtering (replaces is_latest scans)
CREATE INDEX IF NOT EXISTS idx_predictions_project_batch ON predictions(project_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_prediction_state_project ON project_prediction_state(project_id);

-- 2) Rewrite rpc_promote_prediction_batch to be O(1): only update SSOT, no mass UPDATE on predictions
CREATE OR REPLACE FUNCTION public.rpc_promote_prediction_batch(
  p_project_id uuid,
  p_batch_id text,
  p_model_id uuid DEFAULT NULL,
  p_selection_version int DEFAULT NULL,
  p_job_id text DEFAULT NULL,
  p_predictions_count int DEFAULT 0,
  p_coverage_pct numeric DEFAULT 0,
  p_is_sanity_fail boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_batch_id text;
  v_batch_exists boolean;
BEGIN
  -- Advisory lock scoped to project (prevents concurrent promotions)
  PERFORM pg_advisory_xact_lock(hashtext('pred_' || p_project_id::text));

  -- Idempotency: check if already promoted
  SELECT latest_batch_id INTO v_current_batch_id
  FROM public.project_prediction_state
  WHERE project_id = p_project_id;

  IF v_current_batch_id IS NOT NULL AND v_current_batch_id = p_batch_id THEN
    -- Already promoted — idempotent success
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'latest_batch_id', p_batch_id,
      'predictions_count', p_predictions_count,
      'message', 'Batch já promovido (idempotente).'
    );
  END IF;

  -- Validate batch exists in predictions table
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

  -- O(1) promotion: only update the SSOT row
  -- No mass UPDATE on predictions table — dashboard reads by batch_id
  INSERT INTO public.project_prediction_state (
    project_id, latest_batch_id, latest_job_id, latest_model_id,
    latest_selection_version, status, predictions_count, coverage_pct,
    last_error_code, last_error_message, updated_at, last_heartbeat_at
  ) VALUES (
    p_project_id, p_batch_id, p_job_id, p_model_id,
    p_selection_version,
    CASE WHEN p_is_sanity_fail THEN 'sanity_fail' ELSE 'done' END,
    p_predictions_count, p_coverage_pct,
    CASE WHEN p_is_sanity_fail THEN 'SANITY_FAIL' ELSE NULL END,
    CASE WHEN p_is_sanity_fail THEN 'Previsões degeneradas' ELSE NULL END,
    now(), now()
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
    updated_at = now(),
    last_heartbeat_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'latest_batch_id', p_batch_id,
    'previous_batch_id', v_current_batch_id,
    'predictions_count', p_predictions_count,
    'message', 'Batch promovido com sucesso (O(1)).'
  );
END;
$$;
