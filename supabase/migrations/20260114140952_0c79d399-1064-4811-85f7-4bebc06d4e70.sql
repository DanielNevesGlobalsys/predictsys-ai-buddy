-- Create function to update updated_at column
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Create project_datasets table for dataset history
CREATE TABLE public.project_datasets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size_bytes BIGINT,
  total_rows INTEGER,
  sample_rows INTEGER,
  columns_count INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT false,
  source_type TEXT NOT NULL DEFAULT 'upload',
  source_metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.project_datasets ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view datasets of their own projects"
ON public.project_datasets FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_datasets.project_id AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can create datasets for their own projects"
ON public.project_datasets FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_datasets.project_id AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update datasets of their own projects"
ON public.project_datasets FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_datasets.project_id AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete datasets of their own projects"
ON public.project_datasets FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_datasets.project_id AND projects.user_id = auth.uid()
));

-- Index for fast lookups
CREATE INDEX idx_project_datasets_project_id ON public.project_datasets(project_id);
CREATE INDEX idx_project_datasets_active ON public.project_datasets(project_id, is_active) WHERE is_active = true;

-- Function to ensure only one active dataset per project
CREATE OR REPLACE FUNCTION public.ensure_single_active_dataset()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_active = true THEN
    UPDATE public.project_datasets
    SET is_active = false, updated_at = now()
    WHERE project_id = NEW.project_id AND id != NEW.id AND is_active = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER ensure_single_active_dataset_trigger
BEFORE INSERT OR UPDATE ON public.project_datasets
FOR EACH ROW
WHEN (NEW.is_active = true)
EXECUTE FUNCTION public.ensure_single_active_dataset();

-- Trigger to update updated_at
CREATE TRIGGER update_project_datasets_updated_at
BEFORE UPDATE ON public.project_datasets
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add dataset_id to import_jobs to link completed imports to datasets
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS dataset_id UUID REFERENCES public.project_datasets(id) ON DELETE SET NULL;