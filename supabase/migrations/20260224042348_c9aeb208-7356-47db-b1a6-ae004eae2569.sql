
-- ═══════════════════════════════════════════════════════════════
-- INGESTION SSOT: Add metadata columns to project_settings
-- ═══════════════════════════════════════════════════════════════

-- Source tracking
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS ingestion_source_type TEXT DEFAULT 'upload',
ADD COLUMN IF NOT EXISTS ingestion_source_config_hash TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ingestion_dataset_id UUID DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ingestion_manifest_id UUID DEFAULT NULL;

-- Diagnostics
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS ingestion_rows_detected INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS ingestion_cols_detected INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS ingestion_file_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS ingestion_total_bytes BIGINT DEFAULT 0;

-- Error tracking
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS ingestion_error_code TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ingestion_error_message TEXT DEFAULT NULL;

-- Timing & recovery
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS ingestion_started_at TIMESTAMPTZ DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ingestion_finished_at TIMESTAMPTZ DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ingestion_attempt_count INTEGER DEFAULT 0;

-- Comments for documentation
COMMENT ON COLUMN public.project_settings.ingestion_source_type IS 'upload|databricks|powerbi|database|connector';
COMMENT ON COLUMN public.project_settings.ingestion_source_config_hash IS 'SHA256 hash of source config for idempotency check';
COMMENT ON COLUMN public.project_settings.ingestion_error_code IS 'Standardized error code: UPLOAD_PARSE_ERROR, CONNECTOR_AUTH_ERROR, etc.';
COMMENT ON COLUMN public.project_settings.ingestion_attempt_count IS 'Number of ingestion attempts for this project';

-- ═══════════════════════════════════════════════════════════════
-- RPC: Recover stale ingestion (running > 30min)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rpc_recover_stale_ingestion(p_project_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_state TEXT;
  v_started TIMESTAMPTZ;
  v_elapsed INTERVAL;
BEGIN
  SELECT ingestion_state, ingestion_started_at
  INTO v_state, v_started
  FROM public.project_settings
  WHERE project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'PROJECT_NOT_FOUND');
  END IF;

  -- Only recover if stuck in running
  IF v_state <> 'running' THEN
    RETURN jsonb_build_object('success', true, 'status', 'NOT_STALE', 'current_state', v_state);
  END IF;

  v_elapsed := now() - COALESCE(v_started, now() - INTERVAL '1 hour');

  IF v_elapsed < INTERVAL '30 minutes' THEN
    RETURN jsonb_build_object(
      'success', true, 'status', 'STILL_RUNNING',
      'elapsed_minutes', EXTRACT(EPOCH FROM v_elapsed) / 60
    );
  END IF;

  -- Mark as failed with STALE_INGESTION
  UPDATE public.project_settings
  SET ingestion_state = 'failed',
      ingestion_error_code = 'STALE_INGESTION',
      ingestion_error_message = format('Ingestão travada por %s minutos. Marcada como falha para permitir retry.', 
        ROUND(EXTRACT(EPOCH FROM v_elapsed) / 60)),
      ingestion_finished_at = now(),
      updated_at = now()
  WHERE project_id = p_project_id;

  RETURN jsonb_build_object(
    'success', true, 'status', 'RECOVERED',
    'elapsed_minutes', EXTRACT(EPOCH FROM v_elapsed) / 60,
    'error_code', 'STALE_INGESTION'
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- RPC: Start ingestion with idempotency + lock + cascade
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rpc_start_ingestion(
  p_project_id UUID,
  p_source_type TEXT,
  p_source_config_hash TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_current RECORD;
BEGIN
  -- Advisory lock per project
  PERFORM pg_advisory_xact_lock(hashtext('ingestion_' || p_project_id::text));

  SELECT ingestion_state, ingestion_source_config_hash, ingestion_started_at
  INTO v_current
  FROM public.project_settings
  WHERE project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'PROJECT_NOT_FOUND');
  END IF;

  -- Check for stale running (>30min)
  IF v_current.ingestion_state = 'running' AND v_current.ingestion_started_at IS NOT NULL THEN
    IF (now() - v_current.ingestion_started_at) > INTERVAL '30 minutes' THEN
      -- Auto-recover stale
      UPDATE public.project_settings
      SET ingestion_state = 'failed',
          ingestion_error_code = 'STALE_INGESTION',
          ingestion_error_message = 'Auto-recovered: ingestion was stuck > 30min',
          ingestion_finished_at = now(),
          updated_at = now()
      WHERE project_id = p_project_id;
    ELSE
      -- Still legitimately running
      RETURN jsonb_build_object(
        'success', false, 'error', 'INGESTION_ALREADY_RUNNING',
        'started_at', v_current.ingestion_started_at
      );
    END IF;
  END IF;

  -- Idempotency: same config hash + done = skip
  IF v_current.ingestion_state = 'done' 
     AND p_source_config_hash IS NOT NULL 
     AND v_current.ingestion_source_config_hash = p_source_config_hash THEN
    RETURN jsonb_build_object(
      'success', true, 'status', 'ALREADY_DONE',
      'message', 'Dados já foram importados com esta configuração.'
    );
  END IF;

  -- Config changed → cascade reset downstream
  IF p_source_config_hash IS NOT NULL 
     AND v_current.ingestion_source_config_hash IS NOT NULL
     AND v_current.ingestion_source_config_hash <> p_source_config_hash THEN
    UPDATE public.project_settings
    SET eda_state = 'pending',
        target_state = 'draft',
        split_state = 'draft',
        builder_state = 'draft',
        training_state = 'idle',
        scoring_state = 'idle',
        dashboard_state = 'idle',
        updated_at = now()
    WHERE project_id = p_project_id;
  END IF;

  -- Set RUNNING
  UPDATE public.project_settings
  SET ingestion_state = 'running',
      ingestion_source_type = p_source_type,
      ingestion_source_config_hash = p_source_config_hash,
      ingestion_error_code = NULL,
      ingestion_error_message = NULL,
      ingestion_started_at = now(),
      ingestion_finished_at = NULL,
      ingestion_attempt_count = COALESCE(ingestion_attempt_count, 0) + 1,
      updated_at = now()
  WHERE project_id = p_project_id;

  RETURN jsonb_build_object(
    'success', true, 'status', 'STARTED',
    'attempt', COALESCE(v_current.ingestion_state, 'idle')
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- RPC: Complete ingestion (success or failure)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rpc_complete_ingestion(
  p_project_id UUID,
  p_success BOOLEAN,
  p_rows_detected INTEGER DEFAULT 0,
  p_cols_detected INTEGER DEFAULT 0,
  p_file_count INTEGER DEFAULT 0,
  p_total_bytes BIGINT DEFAULT 0,
  p_dataset_id UUID DEFAULT NULL,
  p_manifest_id UUID DEFAULT NULL,
  p_error_code TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ingestion_' || p_project_id::text));

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
      updated_at = now()
  WHERE project_id = p_project_id;

  -- On success, mark EDA as pending (ready to run)
  IF p_success THEN
    UPDATE public.project_settings
    SET eda_state = 'pending'
    WHERE project_id = p_project_id AND eda_state NOT IN ('done');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'ingestion_state', CASE WHEN p_success THEN 'done' ELSE 'failed' END,
    'error_code', p_error_code
  );
END;
$$;
