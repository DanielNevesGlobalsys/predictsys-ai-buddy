
-- Table: project_contract_audits
CREATE TABLE public.project_contract_audits (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  selection_version integer NOT NULL,
  audit_version integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('pass', 'warn', 'block')),
  predictability_score integer NOT NULL DEFAULT 100,
  gates jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_contract_audits_project_version ON public.project_contract_audits (project_id, selection_version DESC);

-- RLS
ALTER TABLE public.project_contract_audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to contract audits"
  ON public.project_contract_audits FOR ALL
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

CREATE POLICY "Users can view contract audits of their projects"
  ON public.project_contract_audits FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_contract_audits.project_id AND p.user_id = auth.uid()
  ));
