
-- ============================================================
-- UNIFIED STATE MACHINE: Pipeline States + Version Tracking
-- Add to project_settings as the single SSOT
-- ============================================================

-- 1) Pipeline state columns (formal state per stage)
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS ingestion_state TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS eda_state TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS target_state TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS split_state TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS builder_state TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS training_state TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS scoring_state TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS dashboard_state TEXT NOT NULL DEFAULT 'idle';

-- 2) Version tracking columns (monotonically increasing)
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS selection_version INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dataset_version INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS training_version INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scoring_version INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dashboard_version INT NOT NULL DEFAULT 0;

-- 3) Split policy reference
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS split_policy_id UUID NULL;

-- 4) Active intent contract reference
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS active_intent_contract_id UUID NULL;

-- 5) Staleness metadata (computed by state machine)
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS staleness_flags JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================
-- BACKFILL: Populate states from existing tables
-- ============================================================

-- Backfill ingestion_state from project_dataset_state
UPDATE public.project_settings ps
SET ingestion_state = CASE
  WHEN pds.row_count > 0 THEN 'done'
  ELSE 'idle'
END
FROM public.project_dataset_state pds
WHERE pds.project_id = ps.project_id;

-- Backfill eda_state from project_dataset_state
UPDATE public.project_settings ps
SET eda_state = CASE
  WHEN pds.eda_ready = true THEN 'done'
  ELSE 'pending'
END
FROM public.project_dataset_state pds
WHERE pds.project_id = ps.project_id;

-- Backfill target_state
UPDATE public.project_settings
SET target_state = CASE
  WHEN target_column IS NOT NULL AND target_column != '' THEN 'ready'
  ELSE 'draft'
END;

-- Backfill selection_version from project_model_selection
UPDATE public.project_settings ps
SET selection_version = COALESCE(pms.selection_version, 0)
FROM public.project_model_selection pms
WHERE pms.project_id = ps.project_id;

-- Backfill builder_state and dataset_version from project_modeling_datasets
UPDATE public.project_settings ps
SET builder_state = CASE
  WHEN pmd.status = 'ready' AND pmd.is_current = true THEN 'ready'
  WHEN pmd.status = 'warning' AND pmd.is_current = true THEN 'ready'
  WHEN pmd.status = 'building' THEN 'building'
  WHEN pmd.status = 'blocked' THEN 'blocked'
  ELSE 'draft'
END,
dataset_version = COALESCE(pmd.selection_version_used, 0)
FROM (
  SELECT DISTINCT ON (project_id) project_id, status, is_current, selection_version_used
  FROM public.project_modeling_datasets
  ORDER BY project_id, created_at DESC
) pmd
WHERE pmd.project_id = ps.project_id;

-- Backfill training_state and training_version from project_models
UPDATE public.project_settings ps
SET training_state = CASE
  WHEN pm.status IN ('trained', 'completed') THEN 'done'
  WHEN pm.status = 'training' THEN 'running'
  WHEN pm.status = 'failed' THEN 'failed'
  ELSE 'idle'
END,
training_version = COALESCE(pm.deployed_selection_version, 0)
FROM (
  SELECT DISTINCT ON (project_id) project_id, status, deployed_selection_version
  FROM public.project_models
  ORDER BY project_id, created_at DESC
) pm
WHERE pm.project_id = ps.project_id;

-- Backfill scoring_state and scoring_version from project_prediction_state
UPDATE public.project_settings ps
SET scoring_state = CASE
  WHEN pps.status = 'done' THEN 'done'
  WHEN pps.status = 'running' THEN 'running'
  WHEN pps.status = 'finalizing' THEN 'finalizing'
  WHEN pps.status = 'failed' THEN 'failed'
  ELSE 'idle'
END,
scoring_version = COALESCE(pps.latest_selection_version, 0)
FROM public.project_prediction_state pps
WHERE pps.project_id = ps.project_id;

-- Backfill split_state from project_split_policies
UPDATE public.project_settings ps
SET split_state = CASE
  WHEN sp.status = 'ready' THEN 'ready'
  WHEN sp.status = 'blocked' THEN 'blocked'
  WHEN sp.status = 'outdated' THEN 'draft'
  ELSE 'draft'
END,
split_policy_id = sp.id
FROM (
  SELECT DISTINCT ON (project_id) project_id, id, status
  FROM public.project_split_policies
  ORDER BY project_id, created_at DESC
) sp
WHERE sp.project_id = ps.project_id;

-- ============================================================
-- COMPUTE STALENESS FLAGS
-- ============================================================
UPDATE public.project_settings
SET staleness_flags = jsonb_build_object(
  'builder_stale', dataset_version < selection_version AND selection_version > 0,
  'training_stale', training_version < dataset_version AND dataset_version > 0,
  'scoring_stale', scoring_version < training_version AND training_version > 0,
  'dashboard_stale', dashboard_version < scoring_version AND scoring_version > 0
);

-- ============================================================
-- RPC: Atomic pipeline state transition
-- ============================================================
CREATE OR REPLACE FUNCTION public.rpc_update_pipeline_state(
  p_project_id UUID,
  p_stage TEXT,
  p_new_state TEXT,
  p_version_increment BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_valid_stages TEXT[] := ARRAY['ingestion','eda','target','split','builder','training','scoring','dashboard'];
  v_valid_states JSONB := '{
    "ingestion": ["idle","running","done","failed"],
    "eda": ["pending","done"],
    "target": ["draft","ready","blocked","stale"],
    "split": ["draft","ready","blocked"],
    "builder": ["draft","building","ready","blocked"],
    "training": ["idle","running","done","failed"],
    "scoring": ["idle","running","finalizing","done","failed"],
    "dashboard": ["idle","calculating","ready","stale"]
  }'::jsonb;
  v_allowed TEXT[];
  v_current_state TEXT;
  v_col TEXT;
  v_ver_col TEXT;
  v_new_version INT;
BEGIN
  -- Validate stage
  IF NOT (p_stage = ANY(v_valid_stages)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_STAGE', 'message', format('Stage "%s" not valid', p_stage));
  END IF;

  -- Validate state for this stage
  SELECT array_agg(x.val) INTO v_allowed
  FROM jsonb_array_elements_text(v_valid_states->p_stage) x(val);
  
  IF NOT (p_new_state = ANY(v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_STATE', 
      'message', format('State "%s" not valid for stage "%s". Allowed: %s', p_new_state, p_stage, array_to_string(v_allowed, ',')));
  END IF;

  v_col := p_stage || '_state';

  -- Lock row
  PERFORM 1 FROM public.project_settings WHERE project_id = p_project_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'PROJECT_NOT_FOUND');
  END IF;

  -- Update state
  EXECUTE format('UPDATE public.project_settings SET %I = $1, updated_at = now() WHERE project_id = $2', v_col)
  USING p_new_state, p_project_id;

  -- Increment version if requested
  v_new_version := 0;
  IF p_version_increment THEN
    v_ver_col := CASE p_stage
      WHEN 'builder' THEN 'dataset_version'
      WHEN 'training' THEN 'training_version'
      WHEN 'scoring' THEN 'scoring_version'
      WHEN 'dashboard' THEN 'dashboard_version'
      ELSE NULL
    END;
    
    IF v_ver_col IS NOT NULL THEN
      EXECUTE format('UPDATE public.project_settings SET %I = %I + 1, updated_at = now() WHERE project_id = $1 RETURNING %I', v_ver_col, v_ver_col, v_ver_col)
      INTO v_new_version
      USING p_project_id;
    END IF;
  END IF;

  -- Recompute staleness flags
  UPDATE public.project_settings
  SET staleness_flags = jsonb_build_object(
    'builder_stale', dataset_version < selection_version AND selection_version > 0,
    'training_stale', training_version < dataset_version AND dataset_version > 0,
    'scoring_stale', scoring_version < training_version AND training_version > 0,
    'dashboard_stale', dashboard_version < scoring_version AND scoring_version > 0
  )
  WHERE project_id = p_project_id;

  RETURN jsonb_build_object(
    'success', true,
    'stage', p_stage,
    'new_state', p_new_state,
    'version_incremented', p_version_increment,
    'new_version', v_new_version
  );
END;
$$;

-- ============================================================
-- TRIGGER: Auto-recompute staleness on any version change
-- ============================================================
CREATE OR REPLACE FUNCTION public.recompute_staleness_flags()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  NEW.staleness_flags := jsonb_build_object(
    'builder_stale', NEW.dataset_version < NEW.selection_version AND NEW.selection_version > 0,
    'training_stale', NEW.training_version < NEW.dataset_version AND NEW.dataset_version > 0,
    'scoring_stale', NEW.scoring_version < NEW.training_version AND NEW.training_version > 0,
    'dashboard_stale', NEW.dashboard_version < NEW.scoring_version AND NEW.scoring_version > 0
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_staleness ON public.project_settings;
CREATE TRIGGER trg_recompute_staleness
  BEFORE INSERT OR UPDATE OF selection_version, dataset_version, training_version, scoring_version, dashboard_version
  ON public.project_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_staleness_flags();

-- ============================================================
-- Schema cache reload
-- ============================================================
NOTIFY pgrst, 'reload schema';
