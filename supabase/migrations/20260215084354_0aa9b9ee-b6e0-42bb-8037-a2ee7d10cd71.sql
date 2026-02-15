
-- Create project_model_rankings table for champion/challenger tracking
CREATE TABLE public.project_model_rankings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  selection_version integer NOT NULL DEFAULT 0,
  ranking_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  champion_model_id uuid REFERENCES public.project_models(id) ON DELETE SET NULL,
  metrics_profile_used text NOT NULL DEFAULT 'generic',
  primary_metric text NOT NULL DEFAULT 'AUC',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX idx_model_rankings_project_version ON public.project_model_rankings (project_id, selection_version DESC);

-- Enable RLS
ALTER TABLE public.project_model_rankings ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view rankings of their own projects"
ON public.project_model_rankings FOR SELECT
USING (EXISTS (SELECT 1 FROM projects WHERE projects.id = project_model_rankings.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Users can insert rankings for their own projects"
ON public.project_model_rankings FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM projects WHERE projects.id = project_model_rankings.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Users can delete rankings of their own projects"
ON public.project_model_rankings FOR DELETE
USING (EXISTS (SELECT 1 FROM projects WHERE projects.id = project_model_rankings.project_id AND projects.user_id = auth.uid()));

CREATE POLICY "Service role full access to model rankings"
ON public.project_model_rankings FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');
