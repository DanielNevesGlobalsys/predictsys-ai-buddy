
-- Table to persist built modeling datasets
CREATE TABLE public.project_modeling_datasets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  dataset_id UUID REFERENCES public.project_datasets(id),
  intent_version TEXT,
  manifest_version TEXT,
  
  -- Target/Label definition
  entity_key TEXT,
  anchor_time_col TEXT,
  target_column TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'binary', -- binary, multiclass, regression, derived
  target_source TEXT NOT NULL DEFAULT 'direct', -- direct, label_builder
  label_plan JSONB DEFAULT '{}'::jsonb, -- label builder spec if derived
  window_days INTEGER,
  
  -- Features
  features_final JSONB NOT NULL DEFAULT '[]'::jsonb,
  features_generated JSONB DEFAULT '[]'::jsonb, -- auto-generated features
  features_blocked JSONB DEFAULT '[]'::jsonb,
  
  -- Dataset stats
  row_count INTEGER DEFAULT 0,
  column_count INTEGER DEFAULT 0,
  coverage_pct NUMERIC DEFAULT 0,
  leakage_report JSONB DEFAULT '[]'::jsonb,
  
  -- Split strategy
  split_strategy TEXT DEFAULT 'stratified',
  
  -- Status
  status TEXT NOT NULL DEFAULT 'pending', -- pending, building, ready, blocked, error
  blocked_reasons JSONB DEFAULT '[]'::jsonb,
  build_log JSONB DEFAULT '{}'::jsonb,
  error_message TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.project_modeling_datasets ENABLE ROW LEVEL SECURITY;

-- RLS: service_role full access
CREATE POLICY "Service role full access to modeling datasets"
  ON public.project_modeling_datasets FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- RLS: users can view their org's modeling datasets
CREATE POLICY "Users can view modeling datasets in their orgs"
  ON public.project_modeling_datasets FOR SELECT
  USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- RLS: users can insert for their own projects
CREATE POLICY "Users can insert modeling datasets for their projects"
  ON public.project_modeling_datasets FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p 
    WHERE p.id = project_modeling_datasets.project_id 
    AND p.user_id = auth.uid()
  ));

-- RLS: users can update their own project's datasets
CREATE POLICY "Users can update modeling datasets for their projects"
  ON public.project_modeling_datasets FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM projects p 
    WHERE p.id = project_modeling_datasets.project_id 
    AND p.user_id = auth.uid()
  ));

-- RLS: users can delete their own project's datasets
CREATE POLICY "Users can delete modeling datasets for their projects"
  ON public.project_modeling_datasets FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM projects p 
    WHERE p.id = project_modeling_datasets.project_id 
    AND p.user_id = auth.uid()
  ));

-- Trigger for updated_at
CREATE TRIGGER update_project_modeling_datasets_updated_at
  BEFORE UPDATE ON public.project_modeling_datasets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Index for lookups
CREATE INDEX idx_project_modeling_datasets_project ON public.project_modeling_datasets(project_id);
CREATE INDEX idx_project_modeling_datasets_status ON public.project_modeling_datasets(project_id, status);
