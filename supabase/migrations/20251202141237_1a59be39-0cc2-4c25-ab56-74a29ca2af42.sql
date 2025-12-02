-- Tabela para armazenar os modelos treinados
CREATE TABLE public.project_models (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  algorithm_name TEXT NOT NULL,
  problem_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'training',
  is_production BOOLEAN NOT NULL DEFAULT false,
  trained_at TIMESTAMP WITH TIME ZONE,
  hyperparameters JSONB DEFAULT '{}'::jsonb,
  model_location TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Tabela para métricas dos modelos
CREATE TABLE public.project_model_metrics (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_model_id UUID NOT NULL REFERENCES public.project_models(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  metric_value DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Tabela para importância das features
CREATE TABLE public.project_feature_importances (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_model_id UUID NOT NULL REFERENCES public.project_models(id) ON DELETE CASCADE,
  feature_name TEXT NOT NULL,
  importance_value DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Habilitar RLS
ALTER TABLE public.project_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_model_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_feature_importances ENABLE ROW LEVEL SECURITY;

-- RLS policies para project_models
CREATE POLICY "Users can view models of their own projects"
ON public.project_models FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.projects
  WHERE projects.id = project_models.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can insert models for their own projects"
ON public.project_models FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects
  WHERE projects.id = project_models.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update models of their own projects"
ON public.project_models FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM public.projects
  WHERE projects.id = project_models.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete models of their own projects"
ON public.project_models FOR DELETE
USING (EXISTS (
  SELECT 1 FROM public.projects
  WHERE projects.id = project_models.project_id
  AND projects.user_id = auth.uid()
));

-- RLS policies para project_model_metrics
CREATE POLICY "Users can view metrics of their own models"
ON public.project_model_metrics FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.project_models pm
  JOIN public.projects p ON p.id = pm.project_id
  WHERE pm.id = project_model_metrics.project_model_id
  AND p.user_id = auth.uid()
));

CREATE POLICY "Users can insert metrics for their own models"
ON public.project_model_metrics FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.project_models pm
  JOIN public.projects p ON p.id = pm.project_id
  WHERE pm.id = project_model_metrics.project_model_id
  AND p.user_id = auth.uid()
));

CREATE POLICY "Users can delete metrics of their own models"
ON public.project_model_metrics FOR DELETE
USING (EXISTS (
  SELECT 1 FROM public.project_models pm
  JOIN public.projects p ON p.id = pm.project_id
  WHERE pm.id = project_model_metrics.project_model_id
  AND p.user_id = auth.uid()
));

-- RLS policies para project_feature_importances
CREATE POLICY "Users can view feature importances of their own models"
ON public.project_feature_importances FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.project_models pm
  JOIN public.projects p ON p.id = pm.project_id
  WHERE pm.id = project_feature_importances.project_model_id
  AND p.user_id = auth.uid()
));

CREATE POLICY "Users can insert feature importances for their own models"
ON public.project_feature_importances FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.project_models pm
  JOIN public.projects p ON p.id = pm.project_id
  WHERE pm.id = project_feature_importances.project_model_id
  AND p.user_id = auth.uid()
));

CREATE POLICY "Users can delete feature importances of their own models"
ON public.project_feature_importances FOR DELETE
USING (EXISTS (
  SELECT 1 FROM public.project_models pm
  JOIN public.projects p ON p.id = pm.project_id
  WHERE pm.id = project_feature_importances.project_model_id
  AND p.user_id = auth.uid()
));