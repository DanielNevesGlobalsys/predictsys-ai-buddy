-- Add batch support for multi-file imports
ALTER TABLE public.import_jobs 
ADD COLUMN batch_id uuid DEFAULT NULL,
ADD COLUMN batch_sequence integer DEFAULT 1,
ADD COLUMN is_batch_primary boolean DEFAULT true;

-- Add index for batch queries
CREATE INDEX idx_import_jobs_batch_id ON public.import_jobs(batch_id) WHERE batch_id IS NOT NULL;

-- Add column compatibility hash to validate compatible headers
ALTER TABLE public.import_jobs 
ADD COLUMN headers_hash text DEFAULT NULL,
ADD COLUMN headers_json jsonb DEFAULT NULL;

COMMENT ON COLUMN public.import_jobs.batch_id IS 'Groups multiple files into a single dataset import batch';
COMMENT ON COLUMN public.import_jobs.batch_sequence IS 'Order of file within the batch (1, 2, 3...)';
COMMENT ON COLUMN public.import_jobs.is_batch_primary IS 'True for the first file in batch - defines the column structure';
COMMENT ON COLUMN public.import_jobs.headers_hash IS 'MD5 hash of column names for compatibility checking';
COMMENT ON COLUMN public.import_jobs.headers_json IS 'Array of column names for validation';