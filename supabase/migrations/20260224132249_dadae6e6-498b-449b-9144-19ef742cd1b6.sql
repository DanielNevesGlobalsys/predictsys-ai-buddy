
-- Relax the source_type constraint to accept all connector types
ALTER TABLE public.project_dataset_state DROP CONSTRAINT IF EXISTS project_dataset_state_source_type_check;
ALTER TABLE public.project_dataset_state ADD CONSTRAINT project_dataset_state_source_type_check
  CHECK (source_type = ANY (ARRAY['upload', 'file', 'db', 'database', 'lake', 'bi', 'powerbi', 'cloud', 'databricks', 'parquet']));
