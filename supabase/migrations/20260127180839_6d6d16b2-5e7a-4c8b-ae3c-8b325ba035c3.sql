-- =============================================
-- PredictSys Analytics (Admin Global) - Tables
-- =============================================

-- 1) Tabela de eventos de produto (event tracking)
CREATE TABLE public.platform_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  duration_ms INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'app'
);

-- Índices para platform_events
CREATE INDEX idx_platform_events_org_time ON public.platform_events(organization_id, timestamp DESC);
CREATE INDEX idx_platform_events_type_time ON public.platform_events(event_type, timestamp DESC);
CREATE INDEX idx_platform_events_project_time ON public.platform_events(project_id, timestamp DESC);
CREATE INDEX idx_platform_events_status_time ON public.platform_events(status, timestamp DESC);
CREATE INDEX idx_platform_events_user_time ON public.platform_events(user_id, timestamp DESC);

-- 2) Tabela de métricas diárias agregadas
CREATE TABLE public.platform_metrics_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day DATE NOT NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Contadores de uso
  projects_created INTEGER NOT NULL DEFAULT 0,
  datasets_connected INTEGER NOT NULL DEFAULT 0,
  models_trained INTEGER NOT NULL DEFAULT 0,
  predictions_run INTEGER NOT NULL DEFAULT 0,
  segments_exported INTEGER NOT NULL DEFAULT 0,
  -- Usuários ativos
  active_users_1d INTEGER NOT NULL DEFAULT 0,
  active_users_7d INTEGER NOT NULL DEFAULT 0,
  active_users_30d INTEGER NOT NULL DEFAULT 0,
  -- Saúde/Performance
  jobs_error_count INTEGER NOT NULL DEFAULT 0,
  avg_import_ms INTEGER DEFAULT 0,
  avg_eda_ms INTEGER DEFAULT 0,
  avg_train_ms INTEGER DEFAULT 0,
  avg_predict_ms INTEGER DEFAULT 0,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Constraint para unicidade
  CONSTRAINT uniq_day_org UNIQUE (day, organization_id)
);

-- Índices para platform_metrics_daily
CREATE INDEX idx_metrics_day ON public.platform_metrics_daily(day DESC);
CREATE INDEX idx_metrics_org ON public.platform_metrics_daily(organization_id, day DESC);

-- 3) Habilitar RLS
ALTER TABLE public.platform_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_metrics_daily ENABLE ROW LEVEL SECURITY;

-- 4) Políticas RLS para platform_events
-- Super admins podem ver todos os eventos
CREATE POLICY "Super admins can view all platform events"
  ON public.platform_events
  FOR SELECT
  USING (public.is_super_admin(auth.uid()));

-- Inserção via service role (edge functions) ou usuários autenticados para seus próprios eventos
CREATE POLICY "Authenticated users can insert their own events"
  ON public.platform_events
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND (user_id = auth.uid() OR user_id IS NULL));

-- Service role pode fazer tudo
CREATE POLICY "Service role full access to platform events"
  ON public.platform_events
  FOR ALL
  USING (auth.role() = 'service_role');

-- 5) Políticas RLS para platform_metrics_daily
-- Super admins podem ver todas as métricas
CREATE POLICY "Super admins can view all platform metrics"
  ON public.platform_metrics_daily
  FOR SELECT
  USING (public.is_super_admin(auth.uid()));

-- Service role pode fazer tudo (para o cron de agregação)
CREATE POLICY "Service role full access to platform metrics"
  ON public.platform_metrics_daily
  FOR ALL
  USING (auth.role() = 'service_role');

-- 6) Trigger para updated_at em platform_metrics_daily
CREATE TRIGGER update_platform_metrics_daily_updated_at
  BEFORE UPDATE ON public.platform_metrics_daily
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- 7) Função para calcular Time to Value por projeto
CREATE OR REPLACE FUNCTION public.calculate_time_to_value(
  p_organization_id UUID DEFAULT NULL,
  p_date_from TIMESTAMPTZ DEFAULT (now() - INTERVAL '30 days'),
  p_date_to TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  organization_id UUID,
  organization_name TEXT,
  avg_project_to_dataset_hours NUMERIC,
  avg_dataset_to_training_hours NUMERIC,
  avg_training_to_prediction_hours NUMERIC,
  avg_prediction_to_export_hours NUMERIC,
  avg_total_time_to_value_hours NUMERIC,
  projects_with_dataset_pct NUMERIC,
  projects_with_training_pct NUMERIC,
  projects_with_prediction_pct NUMERIC,
  projects_with_export_pct NUMERIC,
  total_projects INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH project_milestones AS (
    SELECT 
      pe.project_id,
      p.organization_id AS org_id,
      o.name AS org_name,
      MIN(CASE WHEN pe.event_type = 'project_created' THEN pe.timestamp END) AS project_created_at,
      MIN(CASE WHEN pe.event_type IN ('dataset_connected', 'dataset_uploaded') THEN pe.timestamp END) AS first_dataset_at,
      MIN(CASE WHEN pe.event_type = 'model_trained' THEN pe.timestamp END) AS first_training_at,
      MIN(CASE WHEN pe.event_type = 'prediction_run' THEN pe.timestamp END) AS first_prediction_at,
      MIN(CASE WHEN pe.event_type = 'segment_exported' THEN pe.timestamp END) AS first_export_at
    FROM platform_events pe
    JOIN projects p ON p.id = pe.project_id
    JOIN organizations o ON o.id = p.organization_id
    WHERE pe.timestamp BETWEEN p_date_from AND p_date_to
      AND (p_organization_id IS NULL OR p.organization_id = p_organization_id)
      AND pe.project_id IS NOT NULL
    GROUP BY pe.project_id, p.organization_id, o.name
  )
  SELECT 
    pm.org_id,
    pm.org_name,
    ROUND(AVG(EXTRACT(EPOCH FROM (pm.first_dataset_at - pm.project_created_at)) / 3600)::NUMERIC, 2) AS avg_project_to_dataset_hours,
    ROUND(AVG(EXTRACT(EPOCH FROM (pm.first_training_at - pm.first_dataset_at)) / 3600)::NUMERIC, 2) AS avg_dataset_to_training_hours,
    ROUND(AVG(EXTRACT(EPOCH FROM (pm.first_prediction_at - pm.first_training_at)) / 3600)::NUMERIC, 2) AS avg_training_to_prediction_hours,
    ROUND(AVG(EXTRACT(EPOCH FROM (pm.first_export_at - pm.first_prediction_at)) / 3600)::NUMERIC, 2) AS avg_prediction_to_export_hours,
    ROUND(AVG(EXTRACT(EPOCH FROM (pm.first_export_at - pm.project_created_at)) / 3600)::NUMERIC, 2) AS avg_total_time_to_value_hours,
    ROUND((COUNT(pm.first_dataset_at)::NUMERIC / NULLIF(COUNT(*)::NUMERIC, 0)) * 100, 1) AS projects_with_dataset_pct,
    ROUND((COUNT(pm.first_training_at)::NUMERIC / NULLIF(COUNT(*)::NUMERIC, 0)) * 100, 1) AS projects_with_training_pct,
    ROUND((COUNT(pm.first_prediction_at)::NUMERIC / NULLIF(COUNT(*)::NUMERIC, 0)) * 100, 1) AS projects_with_prediction_pct,
    ROUND((COUNT(pm.first_export_at)::NUMERIC / NULLIF(COUNT(*)::NUMERIC, 0)) * 100, 1) AS projects_with_export_pct,
    COUNT(*)::INTEGER AS total_projects
  FROM project_milestones pm
  GROUP BY pm.org_id, pm.org_name
  ORDER BY pm.org_name;
END;
$$;