
-- Table to persist ModelingContract JSON with versioning
CREATE TABLE public.project_modeling_contracts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  dataset_id UUID REFERENCES public.project_datasets(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'blocked')),
  contract_version TEXT NOT NULL DEFAULT 'v1',
  anchor_time_col TEXT,
  entity_key JSONB,
  target_definition JSONB NOT NULL,
  split_strategy TEXT NOT NULL DEFAULT 'stratified',
  features_final JSONB NOT NULL DEFAULT '[]'::jsonb,
  features_blocked JSONB NOT NULL DEFAULT '[]'::jsonb,
  leakage_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  column_roles JSONB NOT NULL DEFAULT '{}'::jsonb,
  dashboard_gold_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocked_reasons JSONB,
  justification TEXT[],
  full_contract JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookup
CREATE INDEX idx_modeling_contracts_project ON public.project_modeling_contracts(project_id);
CREATE INDEX idx_modeling_contracts_status ON public.project_modeling_contracts(project_id, status);

-- RLS
ALTER TABLE public.project_modeling_contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view contracts in their orgs"
ON public.project_modeling_contracts FOR SELECT
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can insert contracts in their orgs"
ON public.project_modeling_contracts FOR INSERT
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can update contracts in their orgs"
ON public.project_modeling_contracts FOR UPDATE
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete contracts in their orgs"
ON public.project_modeling_contracts FOR DELETE
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- Trigger for updated_at
CREATE TRIGGER update_modeling_contracts_updated_at
BEFORE UPDATE ON public.project_modeling_contracts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
