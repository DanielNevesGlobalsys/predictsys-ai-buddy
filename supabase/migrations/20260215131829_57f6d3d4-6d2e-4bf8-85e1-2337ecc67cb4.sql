
-- Add ON DELETE CASCADE to project_prediction_state foreign keys
ALTER TABLE public.project_prediction_state
  DROP CONSTRAINT IF EXISTS project_prediction_state_latest_model_id_fkey;

ALTER TABLE public.project_prediction_state
  DROP CONSTRAINT IF EXISTS project_prediction_state_project_id_fkey;

ALTER TABLE public.project_prediction_state
  ADD CONSTRAINT project_prediction_state_latest_model_id_fkey
  FOREIGN KEY (latest_model_id) REFERENCES public.project_models(id) ON DELETE SET NULL;

ALTER TABLE public.project_prediction_state
  ADD CONSTRAINT project_prediction_state_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

-- Also update delete_project_cascade to delete project_prediction_state early
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
  -- Delete prediction state FIRST (references project_models)
  DELETE FROM project_prediction_state WHERE project_id = p_project_id;

  SELECT array_agg(id) INTO v_model_ids FROM project_models WHERE project_id = p_project_id;

  IF v_model_ids IS NOT NULL AND array_length(v_model_ids, 1) > 0 THEN
    DELETE FROM project_feature_importances WHERE project_model_id = ANY(v_model_ids);
    DELETE FROM project_model_metrics WHERE project_model_id = ANY(v_model_ids);
    DELETE FROM project_model_insights WHERE model_id = ANY(v_model_ids);
  END IF;

  DELETE FROM project_schedule_runs WHERE project_id = p_project_id;
  DELETE FROM project_schedules WHERE project_id = p_project_id;
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
