
-- =============================================
-- SSOT: project_dataset_state table
-- =============================================
CREATE TABLE public.project_dataset_state (
  project_id UUID NOT NULL PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  source_type TEXT NOT NULL DEFAULT 'upload' CHECK (source_type IN ('upload', 'db', 'lake', 'bi')),
  active_dataset_ref TEXT,
  active_schema_json JSONB DEFAULT '[]'::jsonb,
  row_count BIGINT NOT NULL DEFAULT 0,
  col_count INTEGER NOT NULL DEFAULT 0,
  eda_ready BOOLEAN NOT NULL DEFAULT false,
  model_ready BOOLEAN NOT NULL DEFAULT false,
  manifest_id UUID REFERENCES public.import_manifests(id),
  virtual_manifest BOOLEAN NOT NULL DEFAULT false,
  last_job_id UUID,
  last_success_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  diagnostics JSONB DEFAULT '{}'::jsonb
);

-- Enable RLS
ALTER TABLE public.project_dataset_state ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access to dataset state"
  ON public.project_dataset_state FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Users can view their own project's dataset state
CREATE POLICY "Users can view dataset state for their projects"
  ON public.project_dataset_state FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_dataset_state.project_id AND p.user_id = auth.uid()
  ));

-- Users can insert/update their own project's dataset state
CREATE POLICY "Users can upsert dataset state for their projects"
  ON public.project_dataset_state FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_dataset_state.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can update dataset state for their projects"
  ON public.project_dataset_state FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_dataset_state.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete dataset state for their projects"
  ON public.project_dataset_state FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_dataset_state.project_id AND p.user_id = auth.uid()
  ));

-- Trigger for updated_at
CREATE TRIGGER update_project_dataset_state_updated_at
  BEFORE UPDATE ON public.project_dataset_state
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Index for org-scoped queries
CREATE INDEX idx_project_dataset_state_org ON public.project_dataset_state(organization_id);

-- Add project_dataset_state to cascade delete function
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
