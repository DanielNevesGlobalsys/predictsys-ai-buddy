
-- =====================================================
-- project_model_selection: canonical user selection with versioning
-- =====================================================
CREATE TABLE public.project_model_selection (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  target_column TEXT,
  problem_type TEXT CHECK (problem_type IN ('classification', 'regression')),
  selected_features JSONB DEFAULT '[]'::jsonb,
  excluded_features JSONB DEFAULT '[]'::jsonb,
  selection_version INTEGER NOT NULL DEFAULT 1,
  target_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  PRIMARY KEY (project_id)
);

ALTER TABLE public.project_model_selection ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view selections of their projects"
ON public.project_model_selection FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects p
  JOIN organization_users ou ON ou.organization_id = p.organization_id
  WHERE p.id = project_model_selection.project_id
    AND ou.user_id = auth.uid() AND ou.status = 'active'
));

CREATE POLICY "Users can insert selections for their projects"
ON public.project_model_selection FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects p WHERE p.id = project_model_selection.project_id AND p.user_id = auth.uid()
));

CREATE POLICY "Users can update selections of their projects"
ON public.project_model_selection FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects p WHERE p.id = project_model_selection.project_id AND p.user_id = auth.uid()
));

CREATE POLICY "Users can delete selections of their projects"
ON public.project_model_selection FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects p WHERE p.id = project_model_selection.project_id AND p.user_id = auth.uid()
));

CREATE POLICY "Service role full access to model selection"
ON public.project_model_selection FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- Add selection_version_used to project_modeling_datasets
ALTER TABLE public.project_modeling_datasets
  ADD COLUMN IF NOT EXISTS selection_version_used INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS stale_reason TEXT;

-- Update cascade function
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
