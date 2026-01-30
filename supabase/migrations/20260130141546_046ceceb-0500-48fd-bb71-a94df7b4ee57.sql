-- Add source mode columns to data_sources table
ALTER TABLE public.data_sources
ADD COLUMN IF NOT EXISTS source_mode text DEFAULT 'table' CHECK (source_mode IN ('table', 'sql')),
ADD COLUMN IF NOT EXISTS source_sql text,
ADD COLUMN IF NOT EXISTS source_sql_hash text,
ADD COLUMN IF NOT EXISTS source_table_full_name text;

-- Create project_data_contract table for canonical data source definition
CREATE TABLE IF NOT EXISTS public.project_data_contract (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  data_source_id uuid REFERENCES public.data_sources(id) ON DELETE SET NULL,
  source_mode text NOT NULL DEFAULT 'table' CHECK (source_mode IN ('table', 'sql')),
  source_definition text NOT NULL, -- Full table name or SQL query
  source_definition_hash text, -- SHA256 hash for change detection
  schema_snapshot jsonb DEFAULT '[]'::jsonb, -- Inferred columns from first run
  row_count_estimate bigint,
  locked boolean NOT NULL DEFAULT false, -- Lock after first training
  locked_at timestamp with time zone,
  locked_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT unique_project_contract UNIQUE (project_id)
);

-- Enable RLS on project_data_contract
ALTER TABLE public.project_data_contract ENABLE ROW LEVEL SECURITY;

-- RLS Policies for project_data_contract
CREATE POLICY "Users can view contracts of their own projects"
ON public.project_data_contract FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_data_contract.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can insert contracts for their own projects"
ON public.project_data_contract FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_data_contract.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update contracts of their own projects"
ON public.project_data_contract FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_data_contract.project_id
  AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete contracts of their own projects"
ON public.project_data_contract FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = project_data_contract.project_id
  AND projects.user_id = auth.uid()
));

-- Trigger for updated_at
CREATE TRIGGER update_project_data_contract_updated_at
BEFORE UPDATE ON public.project_data_contract
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_project_data_contract_project_id 
ON public.project_data_contract(project_id);

CREATE INDEX IF NOT EXISTS idx_data_sources_source_mode 
ON public.data_sources(source_mode);

-- Comment for documentation
COMMENT ON TABLE public.project_data_contract IS 'Canonical data source contract for each project - defines the business rule that governs all pipeline stages';
COMMENT ON COLUMN public.project_data_contract.locked IS 'Set to true after first model training to prevent accidental changes';
COMMENT ON COLUMN public.project_data_contract.source_definition IS 'Full table name (catalog.schema.table) or SQL query depending on source_mode';