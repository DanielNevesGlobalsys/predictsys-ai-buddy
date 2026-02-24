
-- Add activation log column to project_settings
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS ingestion_activation_log jsonb DEFAULT '[]'::jsonb;

-- Create universal idempotent activation RPC
CREATE OR REPLACE FUNCTION public.rpc_activate_ingestion(
  p_project_id uuid,
  p_source_type text,
  p_config_hash text DEFAULT NULL,
  p_dataset_id uuid DEFAULT NULL,
  p_manifest_id uuid DEFAULT NULL,
  p_stats jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_current RECORD;
  v_rows_detected int;
  v_cols_detected int;
  v_file_count int;
  v_total_bytes bigint;
  v_org_id uuid;
  v_new_version int;
  v_log_entry jsonb;
BEGIN
  -- Advisory lock per project
  PERFORM pg_advisory_xact_lock(hashtext('activation_' || p_project_id::text));

  -- Read current state
  SELECT ingestion_state, ingestion_dataset_id, ingestion_manifest_id,
         ingestion_source_config_hash, dataset_version, org_id
  INTO v_current
  FROM public.project_settings
  WHERE project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'PROJECT_NOT_FOUND');
  END IF;

  v_org_id := v_current.org_id;

  -- Extract stats
  v_rows_detected := COALESCE((p_stats->>'rows_detected')::int, 0);
  v_cols_detected := COALESCE((p_stats->>'cols_detected')::int, 0);
  v_file_count := COALESCE((p_stats->>'file_count')::int, 1);
  v_total_bytes := COALESCE((p_stats->>'total_bytes')::bigint, 0);

  -- Idempotency check: same config_hash + manifest_id + already done
  IF v_current.ingestion_state = 'done'
     AND p_config_hash IS NOT NULL
     AND v_current.ingestion_source_config_hash = p_config_hash
     AND (p_manifest_id IS NULL OR v_current.ingestion_manifest_id = p_manifest_id)
  THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'ALREADY_ACTIVE',
      'dataset_version', v_current.dataset_version
    );
  END IF;

  -- Increment dataset_version on new activation
  v_new_version := COALESCE(v_current.dataset_version, 0) + 1;

  -- Build activation log entry
  v_log_entry := jsonb_build_object(
    'activated_at', now()::text,
    'source_type', p_source_type,
    'config_hash', p_config_hash,
    'dataset_id', p_dataset_id,
    'manifest_id', p_manifest_id,
    'rows', v_rows_detected,
    'cols', v_cols_detected,
    'version', v_new_version
  );

  -- Update SSOT
  UPDATE public.project_settings
  SET ingestion_state = 'done',
      ingestion_source_type = p_source_type,
      ingestion_source_config_hash = p_config_hash,
      ingestion_dataset_id = p_dataset_id,
      ingestion_manifest_id = p_manifest_id,
      ingestion_rows_detected = v_rows_detected,
      ingestion_cols_detected = v_cols_detected,
      ingestion_file_count = v_file_count,
      ingestion_total_bytes = v_total_bytes,
      ingestion_error_code = NULL,
      ingestion_error_message = NULL,
      ingestion_finished_at = now(),
      -- Downstream cascade reset
      dataset_version = v_new_version,
      eda_state = 'pending',
      target_state = 'draft',
      split_state = 'draft',
      builder_state = 'draft',
      training_state = 'idle',
      scoring_state = 'idle',
      dashboard_state = 'idle',
      -- Append to activation log (keep last 20 entries)
      ingestion_activation_log = (
        SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
        FROM (
          SELECT e FROM jsonb_array_elements(
            COALESCE(ingestion_activation_log, '[]'::jsonb) || v_log_entry
          ) AS e
          ORDER BY e->>'activated_at' DESC
          LIMIT 20
        ) sub
      ),
      updated_at = now()
  WHERE project_id = p_project_id;

  -- Upsert project_dataset_state (ensures EDA/Preflight can find dataset)
  INSERT INTO public.project_dataset_state (
    project_id, organization_id, source_type,
    row_count, col_count,
    eda_ready, model_ready,
    manifest_id, active_dataset_ref,
    updated_at
  ) VALUES (
    p_project_id, v_org_id, p_source_type,
    v_rows_detected, v_cols_detected,
    false, false,
    p_manifest_id,
    COALESCE(p_dataset_id::text, p_manifest_id::text),
    now()
  )
  ON CONFLICT (project_id) DO UPDATE SET
    source_type = EXCLUDED.source_type,
    row_count = EXCLUDED.row_count,
    col_count = EXCLUDED.col_count,
    manifest_id = EXCLUDED.manifest_id,
    active_dataset_ref = EXCLUDED.active_dataset_ref,
    eda_ready = false,
    model_ready = false,
    updated_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'status', 'ACTIVATED',
    'dataset_version', v_new_version,
    'rows_detected', v_rows_detected,
    'cols_detected', v_cols_detected
  );
END;
$function$;
