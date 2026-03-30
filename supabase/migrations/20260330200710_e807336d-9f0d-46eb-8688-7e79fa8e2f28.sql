
-- Table for PRE resolutions
CREATE TABLE IF NOT EXISTS public.project_predictive_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  resolution_version INT NOT NULL DEFAULT 1,
  intent_contract_version INT NOT NULL DEFAULT 3,
  selection_version INT NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'assisted' CHECK (mode IN ('shadow','assisted','auto')),
  resolution_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  overall_confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','accepted','rejected','promoted')),
  accepted_by UUID REFERENCES auth.users(id),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pre_project ON public.project_predictive_resolutions(project_id);
CREATE INDEX IF NOT EXISTS idx_pre_status ON public.project_predictive_resolutions(project_id, status);

-- RLS
ALTER TABLE public.project_predictive_resolutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own org resolutions" ON public.project_predictive_resolutions
  FOR SELECT TO authenticated
  USING (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE POLICY "Users can insert resolutions" ON public.project_predictive_resolutions
  FOR INSERT TO authenticated
  WITH CHECK (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE POLICY "Users can update own org resolutions" ON public.project_predictive_resolutions
  FOR UPDATE TO authenticated
  USING (public.user_belongs_to_org(auth.uid(), organization_id));

-- SSOT columns on project_settings
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS predictive_resolution_state TEXT DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS active_predictive_resolution_id UUID,
  ADD COLUMN IF NOT EXISTS predictive_resolution_mode TEXT DEFAULT 'assisted',
  ADD COLUMN IF NOT EXISTS predictive_resolution_confidence NUMERIC(4,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS predictive_resolution_summary JSONB DEFAULT '{}'::jsonb;
