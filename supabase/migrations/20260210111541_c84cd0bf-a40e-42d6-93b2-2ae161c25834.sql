
-- Column-level inference matrix: stores per-column semantic/temporal roles, eligibility, and reasoning
CREATE TABLE public.project_column_inference (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  inferred_type TEXT NOT NULL DEFAULT 'desconhecido',
  semantic_role TEXT NOT NULL DEFAULT 'DESCONHECIDO',
  temporal_role TEXT NOT NULL DEFAULT 'DESCONHECIDO',
  can_be_target BOOLEAN NOT NULL DEFAULT false,
  can_be_feature BOOLEAN NOT NULL DEFAULT false,
  block_reasons TEXT[] NOT NULL DEFAULT '{}',
  confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0,
  classification_reasons TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, column_name)
);

-- Index for fast lookups
CREATE INDEX idx_project_column_inference_project ON public.project_column_inference(project_id);

-- Enable RLS
ALTER TABLE public.project_column_inference ENABLE ROW LEVEL SECURITY;

-- Policies: users can read column inference for projects they belong to
CREATE POLICY "Users can view column inference for their org projects"
  ON public.project_column_inference
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.organization_users ou ON ou.organization_id = p.organization_id
      WHERE p.id = project_column_inference.project_id
        AND ou.user_id = auth.uid()
        AND ou.status = 'active'
    )
  );

-- Service role can manage (edge functions use service key)
CREATE POLICY "Service role full access on column inference"
  ON public.project_column_inference
  FOR ALL
  USING (true)
  WITH CHECK (true);
