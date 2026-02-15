
-- ============================================================
-- ETAPA 7: Deploy & Promotion v2
-- Table: project_model_deployments
-- Unique partial index: 1 production model per project
-- RPC: rpc_promote_model_to_production (atomic with advisory lock)
-- ============================================================

-- 1) Deployment history table
CREATE TABLE public.project_model_deployments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  model_id UUID NOT NULL REFERENCES public.project_models(id) ON DELETE CASCADE,
  previous_model_id UUID NULL,
  selection_version INT NOT NULL DEFAULT 0,
  deployed_by UUID NULL,
  reason TEXT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NULL
);

-- Indexes
CREATE INDEX idx_deployments_project_created ON public.project_model_deployments(project_id, created_at DESC);
CREATE INDEX idx_deployments_model ON public.project_model_deployments(model_id);

-- Enable RLS
ALTER TABLE public.project_model_deployments ENABLE ROW LEVEL SECURITY;

-- RLS: users can view deployments for projects in their org
CREATE POLICY "Users can view deployments for their org projects"
  ON public.project_model_deployments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.organization_users ou ON ou.organization_id = p.organization_id
      WHERE p.id = project_model_deployments.project_id
        AND ou.user_id = auth.uid()
        AND ou.status = 'active'
    )
  );

-- RLS: users can insert deployments for their org projects
CREATE POLICY "Users can insert deployments for their org projects"
  ON public.project_model_deployments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.organization_users ou ON ou.organization_id = p.organization_id
      WHERE p.id = project_model_deployments.project_id
        AND ou.user_id = auth.uid()
        AND ou.status = 'active'
    )
  );

-- 2) Unique partial index: at most 1 production model per project
CREATE UNIQUE INDEX idx_unique_production_model_per_project
  ON public.project_models(project_id)
  WHERE is_production = true;

-- 3) Atomic RPC for model promotion
CREATE OR REPLACE FUNCTION public.rpc_promote_model_to_production(
  p_project_id UUID,
  p_model_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_model RECORD;
  v_selection_version INT;
  v_previous_model_id UUID;
  v_deployment_id UUID;
  v_user_id UUID;
BEGIN
  -- Advisory lock scoped to this project (prevents concurrent deploys)
  PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text));

  -- Get current user (may be null if called from service role)
  v_user_id := auth.uid();

  -- Read current selection_version
  SELECT selection_version INTO v_selection_version
  FROM public.project_model_selection
  WHERE project_id = p_project_id;

  v_selection_version := COALESCE(v_selection_version, 0);

  -- Validate model exists, belongs to project, and is trained
  SELECT id, project_id, status, is_production,
         (hyperparameters->>'selection_version')::int AS model_sel_version
  INTO v_model
  FROM public.project_models
  WHERE id = p_model_id AND project_id = p_project_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'MODEL_NOT_FOUND',
      'message', 'Modelo não encontrado neste projeto.'
    );
  END IF;

  IF v_model.status NOT IN ('trained', 'completed') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'MODEL_NOT_TRAINED',
      'message', format('Modelo não está treinado (status=%s).', v_model.status)
    );
  END IF;

  -- Validate selection_version match
  IF v_selection_version > 0 AND v_model.model_sel_version IS NOT NULL
     AND v_model.model_sel_version <> v_selection_version THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'VERSION_MISMATCH',
      'message', format('Modelo treinado com v%s, seleção atual v%s. Retreine.', v_model.model_sel_version, v_selection_version)
    );
  END IF;

  -- Capture previous production model
  SELECT production_model_id INTO v_previous_model_id
  FROM public.project_dataset_state
  WHERE project_id = p_project_id;

  -- Demote ALL production models for this project
  UPDATE public.project_models
  SET is_production = false
  WHERE project_id = p_project_id AND is_production = true;

  -- Promote the target model
  UPDATE public.project_models
  SET is_production = true,
      deployed_at = now(),
      deployed_selection_version = v_selection_version
  WHERE id = p_model_id;

  -- Update SSOT
  UPDATE public.project_dataset_state
  SET production_model_id = p_model_id, updated_at = now()
  WHERE project_id = p_project_id;

  -- Set deployed_selection_version on the model hyperparameters
  UPDATE public.project_models
  SET hyperparameters = COALESCE(hyperparameters, '{}'::jsonb) 
      || jsonb_build_object('deployed_selection_version', v_selection_version)
  WHERE id = p_model_id;

  -- Insert deployment record
  INSERT INTO public.project_model_deployments (
    project_id, model_id, previous_model_id,
    selection_version, deployed_by, reason, status, metadata
  ) VALUES (
    p_project_id, p_model_id, v_previous_model_id,
    v_selection_version, v_user_id, p_reason, 'success',
    jsonb_build_object('rollback', false)
  )
  RETURNING id INTO v_deployment_id;

  RETURN jsonb_build_object(
    'success', true,
    'production_model_id', p_model_id,
    'previous_model_id', v_previous_model_id,
    'selection_version', v_selection_version,
    'deployment_id', v_deployment_id
  );
END;
$function$;
