
-- ===== ETAPA 8: project_prediction_state + RPC atomic batch promotion =====

-- 1) Create project_prediction_state table (SSOT for dashboard)
CREATE TABLE IF NOT EXISTS public.project_prediction_state (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  latest_batch_id text,
  latest_job_id uuid,
  latest_model_id uuid REFERENCES public.project_models(id),
  latest_selection_version int,
  status text NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','running','finalizing','done','failed','sanity_fail')),
  predictions_count int NOT NULL DEFAULT 0,
  coverage_pct numeric NOT NULL DEFAULT 0,
  last_error_code text,
  last_error_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_prediction_state_status ON public.project_prediction_state(status);

-- RLS
ALTER TABLE public.project_prediction_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view prediction state for their org projects"
  ON public.project_prediction_state FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.organization_users ou ON ou.organization_id = p.organization_id
      WHERE p.id = project_prediction_state.project_id
        AND ou.user_id = auth.uid()
        AND ou.status = 'active'
    )
  );

CREATE POLICY "Service role can manage prediction state"
  ON public.project_prediction_state FOR ALL
  USING (true)
  WITH CHECK (true);

-- 2) Atomic RPC: promote prediction batch
CREATE OR REPLACE FUNCTION public.rpc_promote_prediction_batch(
  p_project_id uuid,
  p_batch_id text,
  p_model_id uuid DEFAULT NULL,
  p_selection_version int DEFAULT NULL,
  p_job_id uuid DEFAULT NULL,
  p_predictions_count int DEFAULT 0,
  p_coverage_pct numeric DEFAULT 0,
  p_is_sanity_fail boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_demoted int;
  v_promoted int;
BEGIN
  -- Advisory lock scoped to project (prevents concurrent batch promotions)
  PERFORM pg_advisory_xact_lock(hashtext('pred_' || p_project_id::text));

  -- Demote old predictions
  UPDATE public.predictions
  SET is_latest = false
  WHERE project_id = p_project_id AND is_latest = true AND batch_id IS DISTINCT FROM p_batch_id;
  GET DIAGNOSTICS v_demoted = ROW_COUNT;

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
    'predictions_demoted', v_demoted,
    'predictions_promoted', v_promoted,
    'predictions_count', p_predictions_count
  );
END;
$function$;
