
-- Fix overly permissive policy: restrict to service_role only
DROP POLICY IF EXISTS "Service role full access on import_manifests" ON public.import_manifests;

CREATE POLICY "Service role full access on import_manifests"
  ON public.import_manifests FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
