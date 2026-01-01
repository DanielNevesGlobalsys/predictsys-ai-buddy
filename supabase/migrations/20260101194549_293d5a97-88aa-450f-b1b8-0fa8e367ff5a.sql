-- Add detected_problem_type to projects table
ALTER TABLE public.projects
ADD COLUMN detected_problem_type text DEFAULT NULL;

-- Create table for model insights (persisted AI-generated insights about training)
CREATE TABLE public.project_model_insights (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL,
  model_id UUID REFERENCES public.project_models(id) ON DELETE CASCADE,
  insight_type text NOT NULL DEFAULT 'training',
  language text NOT NULL DEFAULT 'pt',
  insights jsonb NOT NULL DEFAULT '[]'::jsonb,
  shap_insights jsonb DEFAULT NULL,
  recommendation_text text DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.project_model_insights ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view insights of their own projects"
ON public.project_model_insights
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_model_insights.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can insert insights for their own projects"
ON public.project_model_insights
FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_model_insights.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update insights of their own projects"
ON public.project_model_insights
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_model_insights.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete insights of their own projects"
ON public.project_model_insights
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_model_insights.project_id
  AND projects.user_id = auth.uid()
));

-- Add trigger for updated_at
CREATE TRIGGER update_project_model_insights_updated_at
BEFORE UPDATE ON public.project_model_insights
FOR EACH ROW
EXECUTE FUNCTION public.handle_updated_at();