-- Create table for data sources/connections
CREATE TABLE public.data_sources (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'file', 'database', 'cloud'
  connector_type TEXT NOT NULL, -- 'csv', 'parquet', 'excel', 'json', 'postgresql', 'mysql', 'sqlserver', 'oracle', 'powerbi', 'azure_sql', 'azure_synapse', 'azure_blob', 'aws_rds', 'aws_redshift', 'aws_s3', 'aws_athena'
  connection_config JSONB NOT NULL DEFAULT '{}'::jsonb, -- encrypted connection details
  is_continuous BOOLEAN NOT NULL DEFAULT false, -- snapshot vs continuous connection
  incremental_key TEXT, -- column for incremental sync
  last_sync_at TIMESTAMP WITH TIME ZONE,
  sync_status TEXT DEFAULT 'idle', -- 'idle', 'syncing', 'success', 'error'
  sync_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create table for project data ingestion logs
CREATE TABLE public.project_data_ingestion_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  data_source_id UUID REFERENCES public.data_sources(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'success', 'error'
  rows_read INTEGER DEFAULT 0,
  rows_sampled INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Add data_source_id to projects table
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS data_source_id UUID REFERENCES public.data_sources(id) ON DELETE SET NULL;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS sample_rows INTEGER;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS total_rows INTEGER;

-- Enable RLS
ALTER TABLE public.data_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_data_ingestion_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for data_sources
CREATE POLICY "Users can view their own data sources"
  ON public.data_sources FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own data sources"
  ON public.data_sources FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own data sources"
  ON public.data_sources FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own data sources"
  ON public.data_sources FOR DELETE
  USING (auth.uid() = user_id);

-- RLS Policies for project_data_ingestion_logs
CREATE POLICY "Users can view ingestion logs of their own projects"
  ON public.project_data_ingestion_logs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects WHERE projects.id = project_data_ingestion_logs.project_id AND projects.user_id = auth.uid()
  ));

CREATE POLICY "Users can create ingestion logs for their own projects"
  ON public.project_data_ingestion_logs FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects WHERE projects.id = project_data_ingestion_logs.project_id AND projects.user_id = auth.uid()
  ));

CREATE POLICY "Users can update ingestion logs of their own projects"
  ON public.project_data_ingestion_logs FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM projects WHERE projects.id = project_data_ingestion_logs.project_id AND projects.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete ingestion logs of their own projects"
  ON public.project_data_ingestion_logs FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM projects WHERE projects.id = project_data_ingestion_logs.project_id AND projects.user_id = auth.uid()
  ));

-- Create trigger for updated_at on data_sources
CREATE TRIGGER update_data_sources_updated_at
  BEFORE UPDATE ON public.data_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();