
-- Create project_exports table for executive PDF exports
CREATE TABLE public.project_exports (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NULL,
  export_type text NOT NULL,
  batch_id text NULL,
  selection_version_scored integer NULL,
  selection_version_current integer NULL,
  confidence_score numeric NULL,
  status text NOT NULL DEFAULT 'done',
  file_path text NOT NULL,
  meta jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_project_exports_project_created ON public.project_exports (project_id, created_at DESC);
CREATE INDEX idx_project_exports_org_created ON public.project_exports (organization_id, created_at DESC);
CREATE INDEX idx_project_exports_type ON public.project_exports (export_type);

-- Enable RLS
ALTER TABLE public.project_exports ENABLE ROW LEVEL SECURITY;

-- RLS: Users can view exports of their own projects (via org membership)
CREATE POLICY "Users can view exports of their projects"
  ON public.project_exports FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_exports.project_id AND p.user_id = auth.uid()
  ));

-- RLS: Users can insert exports for their own projects
CREATE POLICY "Users can insert exports for their projects"
  ON public.project_exports FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_exports.project_id AND p.user_id = auth.uid()
  ));

-- RLS: Service role full access
CREATE POLICY "Service role full access to project exports"
  ON public.project_exports FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Trigger for updated_at
CREATE TRIGGER update_project_exports_updated_at
  BEFORE UPDATE ON public.project_exports
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
