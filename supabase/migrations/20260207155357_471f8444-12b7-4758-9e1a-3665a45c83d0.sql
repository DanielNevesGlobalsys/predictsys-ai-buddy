
-- Table: project_eda_snapshots
CREATE TABLE public.project_eda_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  org_id uuid REFERENCES public.organizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  eda_json jsonb NOT NULL
);

CREATE INDEX idx_eda_snapshots_project ON public.project_eda_snapshots(project_id);
CREATE INDEX idx_eda_snapshots_org ON public.project_eda_snapshots(org_id);

ALTER TABLE public.project_eda_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view EDA snapshots of their projects"
ON public.project_eda_snapshots FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_eda_snapshots.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert EDA snapshots for their projects"
ON public.project_eda_snapshots FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_eda_snapshots.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete EDA snapshots of their projects"
ON public.project_eda_snapshots FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_eda_snapshots.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Service role full access to EDA snapshots"
ON public.project_eda_snapshots FOR ALL
USING (auth.role() = 'service_role'::text);

-- Table: project_settings
CREATE TABLE public.project_settings (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  org_id uuid REFERENCES public.organizations(id),
  target_column text,
  problem_type text,
  feature_columns jsonb,
  excluded_columns jsonb,
  target_suggestion_meta jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_settings_org ON public.project_settings(org_id);

ALTER TABLE public.project_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view settings of their projects"
ON public.project_settings FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_settings.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert settings for their projects"
ON public.project_settings FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_settings.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update settings of their projects"
ON public.project_settings FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_settings.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete settings of their projects"
ON public.project_settings FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_settings.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Service role full access to project settings"
ON public.project_settings FOR ALL
USING (auth.role() = 'service_role'::text);

-- Trigger for updated_at on project_settings
CREATE TRIGGER update_project_settings_updated_at
BEFORE UPDATE ON public.project_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
