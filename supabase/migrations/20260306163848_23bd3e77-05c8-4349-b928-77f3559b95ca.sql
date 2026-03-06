-- Drop overly permissive INSERT/UPDATE/DELETE policies on external_connections
-- Mutations should only happen via service-role edge functions
DROP POLICY IF EXISTS "Users can insert connections" ON public.external_connections;
DROP POLICY IF EXISTS "Users can update own connections" ON public.external_connections;
DROP POLICY IF EXISTS "Users can delete own connections" ON public.external_connections;

-- Re-create restricted policies: only org admins can mutate directly (edge functions use service role and bypass RLS)
CREATE POLICY "Org admins can insert connections"
ON public.external_connections
FOR INSERT TO authenticated
WITH CHECK (
  public.is_org_admin_for_org(auth.uid(), organization_id)
  OR public.is_super_admin(auth.uid())
);

CREATE POLICY "Org admins can update connections"
ON public.external_connections
FOR UPDATE TO authenticated
USING (
  public.is_org_admin_for_org(auth.uid(), organization_id)
  OR public.is_super_admin(auth.uid())
);

CREATE POLICY "Org admins can delete connections"
ON public.external_connections
FOR DELETE TO authenticated
USING (
  public.is_org_admin_for_org(auth.uid(), organization_id)
  OR public.is_super_admin(auth.uid())
);