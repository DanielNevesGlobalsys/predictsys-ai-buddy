
-- ═══════════════════════════════════════════════════════════
-- Import Engine v3: Per-file tracking + Events audit
-- ═══════════════════════════════════════════════════════════

-- 1) import_job_files: one row per file in a batch
CREATE TABLE public.import_job_files (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES public.import_jobs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL DEFAULT 0,
  format TEXT NOT NULL DEFAULT 'csv',
  sequence_index INTEGER NOT NULL DEFAULT 0,
  
  -- Processing state
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed | skipped
  rows_detected INTEGER DEFAULT 0,
  cols_detected INTEGER DEFAULT 0,
  schema_json JSONB DEFAULT NULL,       -- { columns, columnTypes, schemaHash }
  schema_hash TEXT DEFAULT NULL,
  sample_json JSONB DEFAULT NULL,       -- first N sample rows (capped at 200)
  checkpoint_cursor JSONB DEFAULT NULL, -- { offset, bytes_read, rows_read } for resumability
  
  -- Quality gates per file
  quality_gate TEXT NOT NULL DEFAULT 'pending', -- pending | approved | warn | blocked
  quality_reasons JSONB DEFAULT '[]'::jsonb,    -- array of { code, message, severity }
  
  -- Error tracking
  error_code TEXT DEFAULT NULL,
  error_message TEXT DEFAULT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  
  -- Timestamps
  started_at TIMESTAMPTZ DEFAULT NULL,
  finished_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for efficient queries
CREATE INDEX idx_import_job_files_job_id ON public.import_job_files(job_id);
CREATE INDEX idx_import_job_files_project_id ON public.import_job_files(project_id);
CREATE INDEX idx_import_job_files_status ON public.import_job_files(status);

-- Enable RLS
ALTER TABLE public.import_job_files ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Service role can manage all import job files"
  ON public.import_job_files FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view their own import job files"
  ON public.import_job_files FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own import job files"
  ON public.import_job_files FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own import job files"
  ON public.import_job_files FOR UPDATE
  USING (auth.uid() = user_id);

-- 2) import_job_events: audit log per step
CREATE TABLE public.import_job_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES public.import_jobs(id) ON DELETE CASCADE,
  file_id UUID REFERENCES public.import_job_files(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  
  event_type TEXT NOT NULL,  -- file_started | file_completed | file_failed | quality_gate | consolidation_started | consolidation_completed | job_completed | job_failed | retry
  severity TEXT NOT NULL DEFAULT 'info', -- info | warn | error
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_import_job_events_job_id ON public.import_job_events(job_id);
CREATE INDEX idx_import_job_events_file_id ON public.import_job_events(file_id);
CREATE INDEX idx_import_job_events_project_id ON public.import_job_events(project_id);

-- Enable RLS
ALTER TABLE public.import_job_events ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Service role can manage all import job events"
  ON public.import_job_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view events of their projects"
  ON public.import_job_events FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = import_job_events.project_id AND p.user_id = auth.uid()
  ));

-- 3) Add phase tracking columns to import_jobs
ALTER TABLE public.import_jobs 
  ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT 'ingest',  -- ingest | consolidate | done | failed
  ADD COLUMN IF NOT EXISTS total_files INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS processed_files INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bytes_total BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bytes_done BIGINT DEFAULT 0;

-- Trigger for updated_at on import_job_files
CREATE TRIGGER update_import_job_files_updated_at
  BEFORE UPDATE ON public.import_job_files
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
