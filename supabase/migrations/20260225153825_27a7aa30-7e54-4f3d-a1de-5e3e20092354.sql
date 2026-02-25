-- Enhance rpc_complete_ingestion to also upsert project_dataset_state
-- This is the root cause: all ingestion paths call this but it never creates dataset_state
CREATE OR REPLACE FUNCTION public.rpc_complete_ingestion(
  p_project_id uuid,
  p_success boolean,
  p_rows_detected integer DEFAULT 0,
  p_cols_detected integer DEFAULT 0,
  p_file_count integer DEFAULT 0,
  p_total_bytes bigint DEFAULT 0,
  p_dataset_id uuid DEFAULT NULL,
  p_manifest_id uuid DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_source_type text;
  v_new_version int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ingestion_' || p_project_id::text));

  -- Get org_id and source_type from project_settings
  SELECT org_id, ingestion_source_type, COALESCE(dataset_version, 0)
  INTO v_org_id, v_source_type, v_new_version
  FROM public.project_settings
  WHERE project_id = p_project_id;

  -- Increment dataset_version on success
  IF p_success THEN
    v_new_version := v_new_version + 1;
  END IF;

  UPDATE public.project_settings
  SET ingestion_state = CASE WHEN p_success THEN 'done' ELSE 'failed' END,
      ingestion_rows_detected = p_rows_detected,
      ingestion_cols_detected = p_cols_detected,
      ingestion_file_count = p_file_count,
      ingestion_total_bytes = p_total_bytes,
      ingestion_dataset_id = p_dataset_id,
      ingestion_manifest_id = p_manifest_id,
      ingestion_error_code = p_error_code,
      ingestion_error_message = p_error_message,
      ingestion_finished_at = now(),
      dataset_version = CASE WHEN p_success THEN v_new_version ELSE dataset_version END,
      updated_at = now()
  WHERE project_id = p_project_id;

  -- On success, mark EDA as pending and reset downstream
  IF p_success THEN
    UPDATE public.project_settings
    SET eda_state = 'pending',
        target_state = CASE WHEN target_state = 'ready' THEN 'stale' ELSE target_state END
    WHERE project_id = p_project_id AND eda_state NOT IN ('done');

    -- CRITICAL FIX: Upsert project_dataset_state so EDA/Preflight find the dataset
    IF p_rows_detected > 0 AND p_cols_detected > 0 THEN
      INSERT INTO public.project_dataset_state (
        project_id, organization_id, source_type,
        row_count, col_count,
        eda_ready, model_ready,
        manifest_id, active_dataset_ref,
        virtual_manifest,
        updated_at
      ) VALUES (
        p_project_id, v_org_id, COALESCE(v_source_type, 'upload'),
        p_rows_detected, p_cols_detected,
        false, false,
        p_manifest_id,
        COALESCE(p_dataset_id::text, p_manifest_id::text, p_project_id::text),
        (p_manifest_id IS NULL),
        now()
      )
      ON CONFLICT (project_id) DO UPDATE SET
        source_type = COALESCE(EXCLUDED.source_type, project_dataset_state.source_type),
        row_count = EXCLUDED.row_count,
        col_count = EXCLUDED.col_count,
        manifest_id = COALESCE(EXCLUDED.manifest_id, project_dataset_state.manifest_id),
        active_dataset_ref = EXCLUDED.active_dataset_ref,
        virtual_manifest = EXCLUDED.virtual_manifest,
        eda_ready = false,
        model_ready = false,
        updated_at = now();
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'ingestion_state', CASE WHEN p_success THEN 'done' ELSE 'failed' END,
    'error_code', p_error_code,
    'dataset_version', v_new_version,
    'dataset_state_upserted', (p_success AND p_rows_detected > 0 AND p_cols_detected > 0)
  );
END;
$function$;