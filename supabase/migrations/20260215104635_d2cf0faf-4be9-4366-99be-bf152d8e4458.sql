
-- ============================================================
-- Template Feedback Loop v1
-- ============================================================

-- 1) Explicit + implicit feedback per project/template
CREATE TABLE public.project_template_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL,
  template_id text NOT NULL,
  industry text,
  intent_id text,
  selection_version integer,
  batch_id text,
  feedback_type text NOT NULL DEFAULT 'explicit' CHECK (feedback_type IN ('explicit', 'implicit')),
  rating smallint CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  tags text[] DEFAULT '{}',
  comment text,
  signals jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_template_feedback ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_template_feedback_project ON public.project_template_feedback(project_id);
CREATE INDEX idx_template_feedback_template ON public.project_template_feedback(template_id);
CREATE INDEX idx_template_feedback_created ON public.project_template_feedback(created_at DESC);
CREATE INDEX idx_template_feedback_industry ON public.project_template_feedback(industry, intent_id);

-- RLS: service role full access
CREATE POLICY "Service role full access to template feedback"
  ON public.project_template_feedback FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- RLS: users can view feedback of their own projects
CREATE POLICY "Users can view template feedback of their projects"
  ON public.project_template_feedback FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_template_feedback.project_id AND p.user_id = auth.uid()
  ));

-- RLS: users can insert feedback for their own projects
CREATE POLICY "Users can insert template feedback for their projects"
  ON public.project_template_feedback FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project_template_feedback.project_id AND p.user_id = auth.uid()
    )
  );

-- 2) Aggregated stats per template (updated periodically)
CREATE TABLE public.template_quality_stats (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id text NOT NULL,
  industry text,
  intent_id text,
  total_uses integer NOT NULL DEFAULT 0,
  success_rate numeric DEFAULT 0,
  avg_monitoring_score numeric DEFAULT 0,
  avg_confidence numeric DEFAULT 0,
  sanity_fail_rate numeric DEFAULT 0,
  avg_coverage numeric DEFAULT 0,
  avg_rating numeric DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(template_id, industry, intent_id)
);

ALTER TABLE public.template_quality_stats ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_template_stats_lookup ON public.template_quality_stats(template_id, industry);

-- RLS: service role full access
CREATE POLICY "Service role full access to template stats"
  ON public.template_quality_stats FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- RLS: anyone authenticated can read stats (public knowledge)
CREATE POLICY "Authenticated users can view template stats"
  ON public.template_quality_stats FOR SELECT
  USING (auth.uid() IS NOT NULL);
