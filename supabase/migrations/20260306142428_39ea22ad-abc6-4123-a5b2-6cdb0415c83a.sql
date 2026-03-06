
-- ══════════════════════════════════════════════════════════════
-- External Connector Discovery & Import Pipeline SSOT Tables
-- ══════════════════════════════════════════════════════════════

-- 1. external_connections: stores validated external connections
CREATE TABLE public.external_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  data_source_id UUID REFERENCES public.data_sources(id) ON DELETE SET NULL,
  connector_type TEXT NOT NULL, -- powerbi, databricks, postgresql, mysql, sqlserver, azure_sql, azure_synapse, azure_blob, aws_s3, aws_rds, aws_redshift, aws_athena
  connection_name TEXT NOT NULL,
  connection_status TEXT NOT NULL DEFAULT 'pending', -- pending, validated, failed
  last_validated_at TIMESTAMPTZ,
  validation_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ext_connections_project ON public.external_connections(project_id);
CREATE INDEX idx_ext_connections_org ON public.external_connections(organization_id);

ALTER TABLE public.external_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own org connections"
  ON public.external_connections FOR SELECT TO authenticated
  USING (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE POLICY "Users can insert connections"
  ON public.external_connections FOR INSERT TO authenticated
  WITH CHECK (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE POLICY "Users can update own connections"
  ON public.external_connections FOR UPDATE TO authenticated
  USING (public.user_belongs_to_org(auth.uid(), organization_id));

CREATE POLICY "Users can delete own connections"
  ON public.external_connections FOR DELETE TO authenticated
  USING (public.user_belongs_to_org(auth.uid(), organization_id));

-- 2. external_discovery_runs: each discovery execution
CREATE TABLE public.external_discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.external_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, running, done, failed
  objects_found INT NOT NULL DEFAULT 0,
  reasons TEXT[] DEFAULT '{}',
  evidence JSONB DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ext_discovery_runs_project ON public.external_discovery_runs(project_id);
CREATE INDEX idx_ext_discovery_runs_connection ON public.external_discovery_runs(connection_id);

ALTER TABLE public.external_discovery_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view discovery runs via project access"
  ON public.external_discovery_runs FOR SELECT TO authenticated
  USING (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Users can insert discovery runs"
  ON public.external_discovery_runs FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Users can update discovery runs"
  ON public.external_discovery_runs FOR UPDATE TO authenticated
  USING (public.user_can_access_project(auth.uid(), project_id));

-- 3. external_discovery_objects: objects found during discovery
CREATE TABLE public.external_discovery_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_run_id UUID NOT NULL REFERENCES public.external_discovery_runs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.external_connections(id) ON DELETE CASCADE,
  object_name TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT 'table', -- table, view, semantic_model, file
  object_schema TEXT, -- schema/database/catalog
  estimated_columns INT,
  estimated_rows BIGINT,
  last_updated_at TIMESTAMPTZ,
  classification TEXT, -- fact, dimension, bridge, unknown
  column_preview JSONB, -- [{name, type, is_key, is_temporal}]
  sample_rows JSONB, -- first 50 rows preview
  metadata JSONB DEFAULT '{}'::jsonb,
  is_selected BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ext_discovery_objects_run ON public.external_discovery_objects(discovery_run_id);
CREATE INDEX idx_ext_discovery_objects_project ON public.external_discovery_objects(project_id);
CREATE INDEX idx_ext_discovery_objects_selected ON public.external_discovery_objects(project_id, is_selected) WHERE is_selected = true;

ALTER TABLE public.external_discovery_objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view discovery objects via project access"
  ON public.external_discovery_objects FOR SELECT TO authenticated
  USING (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Users can update discovery objects (select/deselect)"
  ON public.external_discovery_objects FOR UPDATE TO authenticated
  USING (public.user_can_access_project(auth.uid(), project_id));

-- 4. external_import_runs: each import execution
CREATE TABLE public.external_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.external_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, running, done, failed
  total_objects INT NOT NULL DEFAULT 0,
  objects_completed INT NOT NULL DEFAULT 0,
  objects_failed INT NOT NULL DEFAULT 0,
  reasons TEXT[] DEFAULT '{}',
  evidence JSONB DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ext_import_runs_project ON public.external_import_runs(project_id);

ALTER TABLE public.external_import_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view import runs via project access"
  ON public.external_import_runs FOR SELECT TO authenticated
  USING (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Users can insert import runs"
  ON public.external_import_runs FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Users can update import runs"
  ON public.external_import_runs FOR UPDATE TO authenticated
  USING (public.user_can_access_project(auth.uid(), project_id));

-- 5. external_import_objects: individual object import status
CREATE TABLE public.external_import_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id UUID NOT NULL REFERENCES public.external_import_runs(id) ON DELETE CASCADE,
  discovery_object_id UUID NOT NULL REFERENCES public.external_discovery_objects(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  object_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, importing, staged, promoted, failed
  storage_path TEXT,
  rows_imported BIGINT DEFAULT 0,
  columns_imported INT DEFAULT 0,
  file_size_bytes BIGINT DEFAULT 0,
  dataset_id UUID REFERENCES public.project_datasets(id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ext_import_objects_run ON public.external_import_objects(import_run_id);
CREATE INDEX idx_ext_import_objects_project ON public.external_import_objects(project_id);

ALTER TABLE public.external_import_objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view import objects via project access"
  ON public.external_import_objects FOR SELECT TO authenticated
  USING (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Users can update import objects"
  ON public.external_import_objects FOR UPDATE TO authenticated
  USING (public.user_can_access_project(auth.uid(), project_id));

-- Triggers for updated_at
CREATE TRIGGER set_updated_at_external_connections
  BEFORE UPDATE ON public.external_connections
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
