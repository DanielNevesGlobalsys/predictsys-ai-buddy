
-- ============================================================
-- ENTERPRISE HARDENING: Multi-tenant RLS + Audit + Validation
-- ============================================================

-- 1. Security definer function: validate user has access to project via org
CREATE OR REPLACE FUNCTION public.user_can_access_project(_user_id uuid, _project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    JOIN public.organization_users ou
      ON ou.organization_id = p.organization_id
    WHERE p.id = _project_id
      AND ou.user_id = _user_id
      AND ou.status = 'active'
  )
  OR public.is_super_admin(_user_id)
$$;

-- 2. Upgrade import_jobs RLS: add org-isolation (keep existing user-level + service role)
DROP POLICY IF EXISTS "import_jobs_org_isolation_select" ON public.import_jobs;
CREATE POLICY "import_jobs_org_isolation_select"
  ON public.import_jobs FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.user_can_access_project(auth.uid(), project_id)
    OR auth.role() = 'service_role'
  );

DROP POLICY IF EXISTS "import_jobs_org_isolation_insert" ON public.import_jobs;
CREATE POLICY "import_jobs_org_isolation_insert"
  ON public.import_jobs FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND public.user_can_access_project(auth.uid(), project_id)
  );

DROP POLICY IF EXISTS "import_jobs_org_isolation_update" ON public.import_jobs;
CREATE POLICY "import_jobs_org_isolation_update"
  ON public.import_jobs FOR UPDATE
  USING (
    auth.uid() = user_id
    AND public.user_can_access_project(auth.uid(), project_id)
  );

-- Remove old user-only policies (replaced by org-isolation ones above)
DROP POLICY IF EXISTS "Users can view their own import jobs" ON public.import_jobs;
DROP POLICY IF EXISTS "Users can create their own import jobs" ON public.import_jobs;
DROP POLICY IF EXISTS "Users can update their own import jobs" ON public.import_jobs;

-- 3. project_ingestion_manifests: add user-level RLS (currently only service_role)
DROP POLICY IF EXISTS "manifests_user_select" ON public.project_ingestion_manifests;
CREATE POLICY "manifests_user_select"
  ON public.project_ingestion_manifests FOR SELECT
  USING (
    public.user_can_access_project(auth.uid(), project_id)
    OR auth.role() = 'service_role'
  );

-- Keep service role full access for edge functions (already exists)
-- Remove the overly permissive "true" policy and replace with scoped one
DROP POLICY IF EXISTS "Service role full access on ingestion manifests" ON public.project_ingestion_manifests;

DROP POLICY IF EXISTS "manifests_service_role" ON public.project_ingestion_manifests;
CREATE POLICY "manifests_service_role"
  ON public.project_ingestion_manifests FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 4. Audit table for project_id mismatch detection
CREATE TABLE IF NOT EXISTS public.audit_project_mismatch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  route_project_id uuid,
  body_project_id uuid,
  resolved_project_id uuid,
  endpoint text,
  metadata jsonb DEFAULT '{}'::jsonb
);

ALTER TABLE public.audit_project_mismatch ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages mismatch audit"
  ON public.audit_project_mismatch FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Org admins can view mismatch audit"
  ON public.audit_project_mismatch FOR SELECT
  USING (
    public.is_super_admin(auth.uid())
    OR public.is_org_admin_for_org(auth.uid(), (
      SELECT p.organization_id FROM public.projects p WHERE p.id = audit_project_mismatch.resolved_project_id
    ))
  );

-- 5. import_job_files: upgrade to org-isolation
DROP POLICY IF EXISTS "Users can view their own import job files" ON public.import_job_files;
DROP POLICY IF EXISTS "Users can create their own import job files" ON public.import_job_files;
DROP POLICY IF EXISTS "Users can update their own import job files" ON public.import_job_files;

CREATE POLICY "import_job_files_select"
  ON public.import_job_files FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.user_can_access_project(auth.uid(), project_id)
    OR auth.role() = 'service_role'
  );

CREATE POLICY "import_job_files_insert"
  ON public.import_job_files FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND public.user_can_access_project(auth.uid(), project_id)
  );

CREATE POLICY "import_job_files_update"
  ON public.import_job_files FOR UPDATE
  USING (
    auth.uid() = user_id
    AND public.user_can_access_project(auth.uid(), project_id)
  );
