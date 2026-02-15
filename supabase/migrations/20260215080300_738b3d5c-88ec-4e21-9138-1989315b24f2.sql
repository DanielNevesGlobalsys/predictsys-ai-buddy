
-- project_label_builders: SSOT for derived target labels
CREATE TABLE public.project_label_builders (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  selection_version integer NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'template',
  template_id text,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  preview jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_label_builders_project ON public.project_label_builders (project_id);
CREATE INDEX idx_label_builders_project_version ON public.project_label_builders (project_id, selection_version DESC);

ALTER TABLE public.project_label_builders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to label builders"
  ON public.project_label_builders FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view label builders of their own projects"
  ON public.project_label_builders FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_label_builders.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert label builders for their own projects"
  ON public.project_label_builders FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_label_builders.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can update label builders of their own projects"
  ON public.project_label_builders FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_label_builders.project_id AND p.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete label builders of their own projects"
  ON public.project_label_builders FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_label_builders.project_id AND p.user_id = auth.uid()
  ));

CREATE TRIGGER update_label_builders_updated_at
  BEFORE UPDATE ON public.project_label_builders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
