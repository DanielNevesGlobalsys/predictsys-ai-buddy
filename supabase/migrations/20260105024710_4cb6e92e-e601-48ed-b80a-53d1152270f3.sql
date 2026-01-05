-- Create export jobs table
CREATE TABLE public.export_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  export_type TEXT NOT NULL CHECK (export_type IN ('dataset', 'predictions', 'eda_results')),
  parameters JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  file_url TEXT,
  file_size_bytes BIGINT,
  rows_exported INTEGER,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  started_at TIMESTAMP WITH TIME ZONE,
  finished_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.export_jobs ENABLE ROW LEVEL SECURITY;

-- Users can only see their own export jobs
CREATE POLICY "Users can view their own export jobs" 
ON public.export_jobs 
FOR SELECT 
USING (auth.uid() = user_id);

-- Users can create their own export jobs
CREATE POLICY "Users can create their own export jobs" 
ON public.export_jobs 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Users can update their own export jobs (for status updates via service role)
CREATE POLICY "Users can update their own export jobs" 
ON public.export_jobs 
FOR UPDATE 
USING (auth.uid() = user_id);

-- Create index for faster queries
CREATE INDEX idx_export_jobs_project_user ON public.export_jobs(project_id, user_id);
CREATE INDEX idx_export_jobs_status ON public.export_jobs(status) WHERE status = 'pending';

-- Create storage bucket for exports
INSERT INTO storage.buckets (id, name, public)
VALUES ('exports', 'exports', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for exports bucket
CREATE POLICY "Users can view their own exports"
ON storage.objects
FOR SELECT
USING (bucket_id = 'exports' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Service role can insert exports"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'exports');

CREATE POLICY "Service role can update exports"
ON storage.objects
FOR UPDATE
USING (bucket_id = 'exports');

CREATE POLICY "Users can delete their own exports"
ON storage.objects
FOR DELETE
USING (bucket_id = 'exports' AND auth.uid()::text = (storage.foldername(name))[1]);