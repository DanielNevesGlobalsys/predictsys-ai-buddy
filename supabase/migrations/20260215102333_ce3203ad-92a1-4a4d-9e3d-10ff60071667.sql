
-- ===========================================
-- STAGE 10: Monitoring v1 — Tables & RLS
-- ===========================================

-- 1) SSOT: project_monitoring_state (one row per project)
CREATE TABLE public.project_monitoring_state (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  model_id uuid REFERENCES public.project_models(id) ON DELETE SET NULL,
  latest_batch_id text,
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','warn','alert','failed')),
  monitoring_score integer NOT NULL DEFAULT 100 CHECK (monitoring_score >= 0 AND monitoring_score <= 100),
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_run_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(project_id)
);

-- Indices
CREATE INDEX idx_monitoring_state_project ON public.project_monitoring_state(project_id);
CREATE INDEX idx_monitoring_state_last_run ON public.project_monitoring_state(last_run_at DESC);

-- RLS
ALTER TABLE public.project_monitoring_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to monitoring state"
  ON public.project_monitoring_state FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view monitoring state of their projects"
  ON public.project_monitoring_state FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_monitoring_state.project_id AND p.user_id = auth.uid()
  ));

-- 2) Historical: project_monitoring_reports
CREATE TABLE public.project_monitoring_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  model_id uuid REFERENCES public.project_models(id) ON DELETE SET NULL,
  batch_id text,
  selection_version_scored integer,
  monitoring_score integer NOT NULL DEFAULT 100,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Indices
CREATE INDEX idx_monitoring_reports_project ON public.project_monitoring_reports(project_id, created_at DESC);
CREATE INDEX idx_monitoring_reports_model ON public.project_monitoring_reports(model_id);

-- RLS
ALTER TABLE public.project_monitoring_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to monitoring reports"
  ON public.project_monitoring_reports FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view monitoring reports of their projects"
  ON public.project_monitoring_reports FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_monitoring_reports.project_id AND p.user_id = auth.uid()
  ));
