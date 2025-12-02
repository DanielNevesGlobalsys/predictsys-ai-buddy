-- Create storage bucket for datasets
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('datasets', 'datasets', false, 52428800);

-- Storage policies for datasets bucket
CREATE POLICY "Users can upload their own datasets"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'datasets' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can view their own datasets"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'datasets' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete their own datasets"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'datasets' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Create project_columns table for column metadata
CREATE TABLE public.project_columns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  inferred_type TEXT NOT NULL DEFAULT 'texto',
  column_index INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.project_columns ENABLE ROW LEVEL SECURITY;

-- RLS policies for project_columns (based on project ownership)
CREATE POLICY "Users can view columns of their own projects"
ON public.project_columns FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = project_columns.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert columns for their own projects"
ON public.project_columns FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = project_columns.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update columns of their own projects"
ON public.project_columns FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = project_columns.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete columns of their own projects"
ON public.project_columns FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = project_columns.project_id 
    AND projects.user_id = auth.uid()
  )
);

-- Index for performance
CREATE INDEX idx_project_columns_project_id ON public.project_columns(project_id);