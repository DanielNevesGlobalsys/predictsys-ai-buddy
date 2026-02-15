
-- Create project_split_policies table (SSOT for split strategy)
CREATE TABLE public.project_split_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  selection_version integer NOT NULL,
  strategy text NOT NULL DEFAULT 'random',
  time_anchor_column text NULL,
  entity_key_column text NULL,
  params jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft',
  preview jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_split_policies_project ON public.project_split_policies(project_id);
CREATE INDEX idx_split_policies_project_version ON public.project_split_policies(project_id, selection_version DESC);

-- Updated_at trigger
CREATE TRIGGER update_split_policies_updated_at
  BEFORE UPDATE ON public.project_split_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.project_split_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to split policies"
  ON public.project_split_policies FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view split policies of their projects"
  ON public.project_split_policies FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_split_policies.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert split policies for their projects"
  ON public.project_split_policies FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_split_policies.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can update split policies of their projects"
  ON public.project_split_policies FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_split_policies.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete split policies of their projects"
  ON public.project_split_policies FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_split_policies.project_id AND p.user_id = auth.uid()
  ));
