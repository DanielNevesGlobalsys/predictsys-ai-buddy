-- Create project_features table for declarative feature engineering
CREATE TABLE public.project_features (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  expression JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create unique constraint on project_id + name
CREATE UNIQUE INDEX idx_project_features_project_name ON public.project_features(project_id, name);

-- Create index for faster lookups
CREATE INDEX idx_project_features_project_id ON public.project_features(project_id);
CREATE INDEX idx_project_features_enabled ON public.project_features(project_id, enabled);

-- Enable RLS
ALTER TABLE public.project_features ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view features of their own projects"
ON public.project_features
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_features.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can create features for their own projects"
ON public.project_features
FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_features.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update features of their own projects"
ON public.project_features
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_features.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete features of their own projects"
ON public.project_features
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_features.project_id
  AND projects.user_id = auth.uid()
));

-- Trigger for updated_at
CREATE TRIGGER update_project_features_updated_at
  BEFORE UPDATE ON public.project_features
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();