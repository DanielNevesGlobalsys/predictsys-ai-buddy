
-- ============================================================
-- Table: project_ai_memory (cumulative Lys memory per project)
-- ============================================================
CREATE TABLE public.project_ai_memory (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  eda_snapshot_id UUID REFERENCES public.project_eda_snapshots(id) ON DELETE SET NULL,
  memory_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_project_ai_memory_project ON public.project_ai_memory(project_id);
CREATE INDEX idx_project_ai_memory_org ON public.project_ai_memory(organization_id);

ALTER TABLE public.project_ai_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view AI memory of their own projects"
  ON public.project_ai_memory FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_ai_memory.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert AI memory for their own projects"
  ON public.project_ai_memory FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_ai_memory.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can update AI memory of their own projects"
  ON public.project_ai_memory FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_ai_memory.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete AI memory of their own projects"
  ON public.project_ai_memory FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_ai_memory.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Service role full access to AI memory"
  ON public.project_ai_memory FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Super admins can view all AI memory"
  ON public.project_ai_memory FOR SELECT
  USING (is_super_admin(auth.uid()));

-- ============================================================
-- Table: project_problem_inference (structured inference result)
-- ============================================================
CREATE TABLE public.project_problem_inference (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  dataset_id UUID REFERENCES public.project_datasets(id) ON DELETE SET NULL,
  inference_version TEXT NOT NULL DEFAULT 'v1',
  problem_type TEXT NOT NULL DEFAULT 'unknown',
  suggested_problem_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_predictors JSONB NOT NULL DEFAULT '[]'::jsonb,
  narrative TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_problem_inference_project ON public.project_problem_inference(project_id);
CREATE INDEX idx_project_problem_inference_org ON public.project_problem_inference(organization_id);

ALTER TABLE public.project_problem_inference ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view inferences of their own projects"
  ON public.project_problem_inference FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_problem_inference.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert inferences for their own projects"
  ON public.project_problem_inference FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_problem_inference.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can update inferences of their own projects"
  ON public.project_problem_inference FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_problem_inference.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete inferences of their own projects"
  ON public.project_problem_inference FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_problem_inference.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Service role full access to problem inference"
  ON public.project_problem_inference FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Super admins can view all problem inferences"
  ON public.project_problem_inference FOR SELECT
  USING (is_super_admin(auth.uid()));

-- Trigger for updated_at
CREATE TRIGGER update_project_ai_memory_updated_at
  BEFORE UPDATE ON public.project_ai_memory
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_project_problem_inference_updated_at
  BEFORE UPDATE ON public.project_problem_inference
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
