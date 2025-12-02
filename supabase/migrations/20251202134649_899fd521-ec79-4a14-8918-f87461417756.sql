-- Create table for numeric column statistics
CREATE TABLE public.project_numeric_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  mean_value DOUBLE PRECISION,
  median_value DOUBLE PRECISION,
  std_value DOUBLE PRECISION,
  null_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, column_name)
);

-- Create table for categorical column statistics
CREATE TABLE public.project_categorical_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  distinct_count INTEGER DEFAULT 0,
  top_categories JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, column_name)
);

-- Enable RLS
ALTER TABLE public.project_numeric_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_categorical_stats ENABLE ROW LEVEL SECURITY;

-- RLS policies for numeric stats
CREATE POLICY "Users can view numeric stats of their own projects"
ON public.project_numeric_stats
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_numeric_stats.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can insert numeric stats for their own projects"
ON public.project_numeric_stats
FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_numeric_stats.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update numeric stats of their own projects"
ON public.project_numeric_stats
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_numeric_stats.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete numeric stats of their own projects"
ON public.project_numeric_stats
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_numeric_stats.project_id
  AND projects.user_id = auth.uid()
));

-- RLS policies for categorical stats
CREATE POLICY "Users can view categorical stats of their own projects"
ON public.project_categorical_stats
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_categorical_stats.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can insert categorical stats for their own projects"
ON public.project_categorical_stats
FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_categorical_stats.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update categorical stats of their own projects"
ON public.project_categorical_stats
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_categorical_stats.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete categorical stats of their own projects"
ON public.project_categorical_stats
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_categorical_stats.project_id
  AND projects.user_id = auth.uid()
));