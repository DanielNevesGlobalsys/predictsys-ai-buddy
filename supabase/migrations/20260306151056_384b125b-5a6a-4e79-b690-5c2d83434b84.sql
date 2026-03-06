
CREATE TABLE public.pipeline_validation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES public.external_connections(id) ON DELETE SET NULL,
  import_run_id UUID REFERENCES public.external_import_runs(id) ON DELETE SET NULL,
  dataset_id UUID REFERENCES public.project_datasets(id) ON DELETE SET NULL,
  staging_valid BOOLEAN DEFAULT false,
  metadata_valid BOOLEAN DEFAULT false,
  promotion_valid BOOLEAN DEFAULT false,
  schema_valid BOOLEAN DEFAULT false,
  sample_valid BOOLEAN DEFAULT false,
  eda_valid BOOLEAN DEFAULT false,
  overall_status TEXT NOT NULL DEFAULT 'pending',
  details JSONB DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.pipeline_validation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read validation runs"
  ON public.pipeline_validation_runs FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Service role can manage validation runs"
  ON public.pipeline_validation_runs FOR ALL TO service_role
  USING (true) WITH CHECK (true);
