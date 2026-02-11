
-- =============================================
-- project_scoring_jobs: tracks each scoring run
-- =============================================
CREATE TABLE public.project_scoring_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.project_models(id) ON DELETE CASCADE,
  selection_version integer NOT NULL DEFAULT 0,
  dataset_id uuid REFERENCES public.project_modeling_datasets(id),
  source_type text NOT NULL DEFAULT 'upload',
  status text NOT NULL DEFAULT 'pending',
  "offset" integer NOT NULL DEFAULT 0,
  "limit" integer NOT NULL DEFAULT 40000,
  total_rows_estimated integer NOT NULL DEFAULT 0,
  rows_fetched_total integer NOT NULL DEFAULT 0,
  rows_scored_total integer NOT NULL DEFAULT 0,
  rows_inserted_total integer NOT NULL DEFAULT 0,
  batch_id text NOT NULL,
  is_latest_job boolean NOT NULL DEFAULT false,
  error_code text,
  error_friendly text,
  error_stack text,
  diagnostics jsonb DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE public.project_scoring_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access scoring jobs"
  ON public.project_scoring_jobs FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can view scoring jobs of their projects"
  ON public.project_scoring_jobs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_scoring_jobs.project_id AND p.user_id = auth.uid()
  ));

CREATE INDEX idx_scoring_jobs_project ON public.project_scoring_jobs(project_id, is_latest_job);

-- =============================================
-- project_score_reports: final summary per batch
-- =============================================
CREATE TABLE public.project_score_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.project_models(id) ON DELETE CASCADE,
  batch_id text NOT NULL,
  selection_version integer NOT NULL DEFAULT 0,
  dataset_id uuid REFERENCES public.project_modeling_datasets(id),
  coverage_pct numeric NOT NULL DEFAULT 0,
  predictions_count integer NOT NULL DEFAULT 0,
  invalid_rows integer NOT NULL DEFAULT 0,
  missing_feature_pct numeric NOT NULL DEFAULT 0,
  drift_summary jsonb,
  stats_summary jsonb DEFAULT '{}'::jsonb,
  warnings text[] DEFAULT '{}',
  gates_snapshot jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_score_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access score reports"
  ON public.project_score_reports FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can view score reports of their projects"
  ON public.project_score_reports FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_score_reports.project_id AND p.user_id = auth.uid()
  ));

CREATE INDEX idx_score_reports_project ON public.project_score_reports(project_id, created_at DESC);

-- Trigger for updated_at on scoring_jobs
CREATE TRIGGER update_scoring_jobs_updated_at
  BEFORE UPDATE ON public.project_scoring_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Add to cascade delete function
CREATE OR REPLACE FUNCTION public.delete_project_cascade(p_project_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_deleted_predictions int := 0;
  v_batch int;
  v_model_ids uuid[];
BEGIN
  SELECT array_agg(id) INTO v_model_ids FROM project_models WHERE project_id = p_project_id;

  IF v_model_ids IS NOT NULL AND array_length(v_model_ids, 1) > 0 THEN
    DELETE FROM project_feature_importances WHERE project_model_id = ANY(v_model_ids);
    DELETE FROM project_model_metrics WHERE project_model_id = ANY(v_model_ids);
    DELETE FROM project_model_insights WHERE model_id = ANY(v_model_ids);
  END IF;

  DELETE FROM project_score_reports WHERE project_id = p_project_id;
  DELETE FROM project_scoring_jobs WHERE project_id = p_project_id;
  DELETE FROM project_model_insights WHERE project_id = p_project_id;
  DELETE FROM project_prediction_schedules WHERE project_id = p_project_id;
  DELETE FROM project_models WHERE project_id = p_project_id;
  DELETE FROM project_chat_messages WHERE project_id = p_project_id;
  DELETE FROM project_numeric_stats WHERE project_id = p_project_id;
  DELETE FROM project_categorical_stats WHERE project_id = p_project_id;
  DELETE FROM project_columns WHERE project_id = p_project_id;
  DELETE FROM project_column_inference WHERE project_id = p_project_id;
  DELETE FROM project_eda_insights WHERE project_id = p_project_id;
  DELETE FROM project_eda_snapshots WHERE project_id = p_project_id;
  DELETE FROM project_ai_context WHERE project_id = p_project_id;
  DELETE FROM project_ai_memory WHERE project_id = p_project_id;
  DELETE FROM project_data_contract WHERE project_id = p_project_id;
  DELETE FROM project_features WHERE project_id = p_project_id;
  DELETE FROM project_business_config WHERE project_id = p_project_id;
  DELETE FROM project_actions WHERE project_id = p_project_id;
  DELETE FROM project_data_ingestion_logs WHERE project_id = p_project_id;
  DELETE FROM project_problem_inference WHERE project_id = p_project_id;
  DELETE FROM project_modeling_contracts WHERE project_id = p_project_id;
  DELETE FROM project_modeling_datasets WHERE project_id = p_project_id;
  DELETE FROM project_dataset_state WHERE project_id = p_project_id;
  DELETE FROM project_model_selection WHERE project_id = p_project_id;
  DELETE FROM project_settings WHERE project_id = p_project_id;
  DELETE FROM export_jobs WHERE project_id = p_project_id;

  LOOP
    DELETE FROM predictions WHERE id IN (
      SELECT id FROM predictions WHERE project_id = p_project_id LIMIT 5000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_deleted_predictions := v_deleted_predictions + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;

  DELETE FROM import_manifests WHERE project_id = p_project_id;
  DELETE FROM import_jobs WHERE project_id = p_project_id;
  DELETE FROM project_datasets WHERE project_id = p_project_id;

  UPDATE platform_events SET project_id = NULL WHERE project_id = p_project_id;
  UPDATE audit_logs SET project_id = NULL WHERE project_id = p_project_id;

  DELETE FROM projects WHERE id = p_project_id;

  RETURN jsonb_build_object('success', true, 'predictions_deleted', v_deleted_predictions);
END;
$function$;
