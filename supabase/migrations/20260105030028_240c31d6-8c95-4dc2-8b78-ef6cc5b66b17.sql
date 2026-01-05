-- Create import_jobs table for tracking large CSV imports
CREATE TABLE public.import_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  storage_path TEXT NOT NULL,
  delimiter TEXT DEFAULT ',' NOT NULL,
  encoding TEXT DEFAULT 'UTF-8' NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  rows_processed BIGINT DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  finished_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view their own import jobs"
  ON public.import_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own import jobs"
  ON public.import_jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own import jobs"
  ON public.import_jobs FOR UPDATE
  USING (auth.uid() = user_id);

-- Service role policy for edge functions
CREATE POLICY "Service role can manage all import jobs"
  ON public.import_jobs FOR ALL
  USING (auth.role() = 'service_role');

-- Indexes for performance
CREATE INDEX idx_import_jobs_project_id ON public.import_jobs(project_id);
CREATE INDEX idx_import_jobs_user_id ON public.import_jobs(user_id);
CREATE INDEX idx_import_jobs_status ON public.import_jobs(status);
CREATE INDEX idx_import_jobs_created_at ON public.import_jobs(created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER update_import_jobs_updated_at
  BEFORE UPDATE ON public.import_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- Create big_imports storage bucket
INSERT INTO storage.buckets (id, name, public) 
VALUES ('big_imports', 'big_imports', false);

-- Storage policies for big_imports bucket
CREATE POLICY "Users can upload to big_imports"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'big_imports' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can view their own imports"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'big_imports' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete their own imports"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'big_imports' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Service role can manage big_imports"
  ON storage.objects FOR ALL
  USING (bucket_id = 'big_imports' AND auth.role() = 'service_role');