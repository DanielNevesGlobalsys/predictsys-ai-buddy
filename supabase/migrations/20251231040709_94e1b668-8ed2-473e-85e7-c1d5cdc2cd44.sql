-- Create table for persisting AI EDA insights
CREATE TABLE public.project_eda_insights (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'pt',
  insights JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, language)
);

-- Enable RLS
ALTER TABLE public.project_eda_insights ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view insights of their own projects"
ON public.project_eda_insights
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_eda_insights.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can insert insights for their own projects"
ON public.project_eda_insights
FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_eda_insights.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update insights of their own projects"
ON public.project_eda_insights
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_eda_insights.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete insights of their own projects"
ON public.project_eda_insights
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_eda_insights.project_id
  AND projects.user_id = auth.uid()
));

-- Add trigger for updated_at
CREATE TRIGGER update_project_eda_insights_updated_at
BEFORE UPDATE ON public.project_eda_insights
FOR EACH ROW
EXECUTE FUNCTION public.handle_updated_at();