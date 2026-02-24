
-- ═══════════════════════════════════════════════════════════
-- Activation Contract v2: Manifest as hard requirement
-- ═══════════════════════════════════════════════════════════

-- 1) Create project_ingestion_manifests table
CREATE TABLE IF NOT EXISTS public.project_ingestion_manifests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  dataset_id UUID,
  source_type TEXT NOT NULL DEFAULT 'upload',
  source_pointer JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count INTEGER NOT NULL DEFAULT 0,
  col_count INTEGER NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  sample_strategy JSONB NOT NULL DEFAULT '{"method":"head","max_rows":10000}'::jsonb,
  config_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookup by project
CREATE INDEX IF NOT EXISTS idx_ingestion_manifests_project ON public.project_ingestion_manifests(project_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_manifests_created ON public.project_ingestion_manifests(project_id, created_at DESC);

-- RLS
ALTER TABLE public.project_ingestion_manifests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on ingestion manifests"
  ON public.project_ingestion_manifests
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 2) rpc_finalize_ingestion: atomic manifest creation + state transition
CREATE OR REPLACE FUNCTION public.rpc_finalize_ingestion(
  p_project_id UUID,
  p_source_type TEXT,
  p_config_hash TEXT DEFAULT NULL,
  p_dataset_id UUID DEFAULT NULL,
  p_source_pointer JSONB DEFAULT '{}'::jsonb,
  p_schema_json JSONB DEFAULT '[]'::jsonb,
  p_row_count INTEGER DEFAULT 0,
  p_col_count INTEGER DEFAULT 0,
  p_total_bytes BIGINT DEFAULT 0,
  p_sample_strategy JSONB DEFAULT '{"method":"head","max_rows":10000}'::jsonb,
  p_file_count INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_manifest_id UUID;
  v_org_id UUID;
  v_new_version INT;
  v_log_entry JSONB;
BEGIN
  -- Advisory lock per project
  PERFORM pg_advisory_xact_lock(hashtext('finalize_' || p_project_id::text));

  -- Validate: schema and row_count must be present
  IF p_col_count <= 0 OR p_row_count <= 0 THEN
    -- Mark as failed
    UPDATE public.project_settings
    SET ingestion_state = 'failed',
        ingestion_error_code = CASE
          WHEN p_col_count <= 0 THEN 'SCHEMA_INFERENCE_FAIL'
          ELSE 'EMPTY_DATASET'
        END,
        ingestion_error_message = CASE
          WHEN p_col_count <= 0 THEN 'Schema não detectado (0 colunas).'
          ELSE 'Dataset vazio (0 linhas).'
        END,
        ingestion_finished_at = now(),
        updated_at = now()
    WHERE project_id = p_project_id;

    RETURN jsonb_build_object(
      'success', false,
      'error', CASE WHEN p_col_count <= 0 THEN 'SCHEMA_INFERENCE_FAIL' ELSE 'EMPTY_DATASET' END,
      'message', CASE WHEN p_col_count <= 0 THEN 'Schema não detectado.' ELSE 'Dataset vazio.' END
    );
  END IF;

  -- Get org_id
  SELECT org_id INTO v_org_id
  FROM public.project_settings
  WHERE project_id = p_project_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'PROJECT_NOT_FOUND');
  END IF;

  -- 1) Create manifest
  INSERT INTO public.project_ingestion_manifests (
    project_id, dataset_id, source_type, source_pointer,
    schema_json, row_count, col_count, total_bytes,
    sample_strategy, config_hash
  ) VALUES (
    p_project_id, p_dataset_id, p_source_type, p_source_pointer,
    p_schema_json, p_row_count, p_col_count, p_total_bytes,
    p_sample_strategy, p_config_hash
  )
  RETURNING id INTO v_manifest_id;

  -- 2) Increment dataset_version
  SELECT COALESCE(dataset_version, 0) + 1 INTO v_new_version
  FROM public.project_settings
  WHERE project_id = p_project_id
  FOR UPDATE;

  -- 3) Build log entry
  v_log_entry := jsonb_build_object(
    'activated_at', now()::text,
    'source_type', p_source_type,
    'config_hash', p_config_hash,
    'dataset_id', p_dataset_id,
    'manifest_id', v_manifest_id,
    'rows', p_row_count,
    'cols', p_col_count,
    'version', v_new_version
  );

  -- 4) Update SSOT atomically
  UPDATE public.project_settings
  SET ingestion_state = 'done',
      ingestion_source_type = p_source_type,
      ingestion_source_config_hash = p_config_hash,
      ingestion_dataset_id = p_dataset_id,
      ingestion_manifest_id = v_manifest_id,
      ingestion_rows_detected = p_row_count,
      ingestion_cols_detected = p_col_count,
      ingestion_file_count = p_file_count,
      ingestion_total_bytes = p_total_bytes,
      ingestion_error_code = NULL,
      ingestion_error_message = NULL,
      ingestion_finished_at = now(),
      dataset_version = v_new_version,
      eda_state = 'pending',
      target_state = 'draft',
      split_state = 'draft',
      builder_state = 'draft',
      training_state = 'idle',
      scoring_state = 'idle',
      dashboard_state = 'idle',
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

  -- 5) Upsert project_dataset_state
  INSERT INTO public.project_dataset_state (
    project_id, organization_id, source_type,
    row_count, col_count,
    eda_ready, model_ready,
    manifest_id, active_dataset_ref,
    updated_at
  ) VALUES (
    p_project_id, v_org_id, p_source_type,
    p_row_count, p_col_count,
    false, false,
    v_manifest_id,
    COALESCE(p_dataset_id::text, v_manifest_id::text),
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
    'status', 'FINALIZED',
    'manifest_id', v_manifest_id,
    'dataset_version', v_new_version,
    'rows', p_row_count,
    'cols', p_col_count
  );
END;
$function$;
