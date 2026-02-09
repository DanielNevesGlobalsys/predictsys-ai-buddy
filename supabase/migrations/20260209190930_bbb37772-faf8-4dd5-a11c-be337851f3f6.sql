
-- Table: import_manifests
-- Stores structured import report for each batch/single import
CREATE TABLE public.import_manifests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  dataset_id UUID REFERENCES public.project_datasets(id) ON DELETE SET NULL,
  batch_id TEXT,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Summary totals
  total_files INT NOT NULL DEFAULT 1,
  files_ok INT NOT NULL DEFAULT 0,
  files_warn INT NOT NULL DEFAULT 0,
  files_fail INT NOT NULL DEFAULT 0,
  rows_sum INT NOT NULL DEFAULT 0,          -- sum of rows across all files
  rows_consolidated INT NOT NULL DEFAULT 0, -- rows in final dataset
  rows_difference INT NOT NULL DEFAULT 0,   -- rows_sum - rows_consolidated
  columns_final INT NOT NULL DEFAULT 0,

  -- Consolidated schema
  canonical_schema JSONB DEFAULT '{}',       -- { column_name: type }
  column_mapping_report JSONB DEFAULT '[]',  -- [{ canonical: "x", sources: [{file, original_col}] }]
  null_diagnostic JSONB DEFAULT '[]',        -- [{ column, null_pct, probable_cause, files_with_data }]

  -- Per-file detail
  files JSONB NOT NULL DEFAULT '[]',
  -- Each entry: { file_id, file_name, format, size_mb, rows_detected, rows_loaded, cols_detected,
  --               schema_detected: {col: type}, null_pct_by_col: [{col, pct}], parse_warnings: [],
  --               status: "ok"|"warn"|"fail", missing_cols: [] }

  -- Overall status
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'warn', 'fail')),
  status_reason TEXT
);

-- Enable RLS
ALTER TABLE public.import_manifests ENABLE ROW LEVEL SECURITY;

-- Users can read their own manifests
CREATE POLICY "Users can view their own import manifests"
  ON public.import_manifests FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own manifests  
CREATE POLICY "Users can create their own import manifests"
  ON public.import_manifests FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Service role can do everything (edge functions use service role)
CREATE POLICY "Service role full access on import_manifests"
  ON public.import_manifests FOR ALL
  USING (true)
  WITH CHECK (true);

-- Index for fast lookups
CREATE INDEX idx_import_manifests_project ON public.import_manifests(project_id);
CREATE INDEX idx_import_manifests_batch ON public.import_manifests(batch_id);
