-- 1. Create enum for roles
CREATE TYPE public.app_role AS ENUM ('super_admin', 'org_admin', 'analyst', 'viewer');

-- 2. Create enum for organization plans
CREATE TYPE public.org_plan AS ENUM ('trial', 'standard', 'enterprise');

-- 3. Create organizations table
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  document TEXT,
  plan org_plan NOT NULL DEFAULT 'trial',
  max_projects INTEGER DEFAULT 10,
  max_rows BIGINT DEFAULT 1000000,
  max_storage_mb INTEGER DEFAULT 5000,
  logo_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 4. Create organization_users table
CREATE TABLE public.organization_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL DEFAULT 'analyst',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

-- 5. Add organization_id to projects
ALTER TABLE public.projects ADD COLUMN organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- 6. Add organization_id to data_sources
ALTER TABLE public.data_sources ADD COLUMN organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- 7. Create indexes for performance
CREATE INDEX idx_organizations_slug ON public.organizations(slug);
CREATE INDEX idx_organization_users_user_id ON public.organization_users(user_id);
CREATE INDEX idx_organization_users_org_id ON public.organization_users(organization_id);
CREATE INDEX idx_projects_organization_id ON public.projects(organization_id);
CREATE INDEX idx_data_sources_organization_id ON public.data_sources(organization_id);

-- 8. Enable RLS on new tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_users ENABLE ROW LEVEL SECURITY;

-- 9. Create security definer function to check roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_users
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- 10. Create function to check if user is super_admin
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_users
    WHERE user_id = _user_id
      AND role = 'super_admin'
  )
$$;

-- 11. Create function to check if user belongs to organization
CREATE OR REPLACE FUNCTION public.user_belongs_to_org(_user_id UUID, _org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_users
    WHERE user_id = _user_id
      AND organization_id = _org_id
  )
$$;

-- 12. Create function to get user's organizations
CREATE OR REPLACE FUNCTION public.get_user_organizations(_user_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id
  FROM public.organization_users
  WHERE user_id = _user_id
$$;

-- 13. RLS policies for organizations
CREATE POLICY "Super admins can view all organizations"
ON public.organizations FOR SELECT
USING (public.is_super_admin(auth.uid()));

CREATE POLICY "Users can view their own organizations"
ON public.organizations FOR SELECT
USING (id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Super admins can insert organizations"
ON public.organizations FOR INSERT
WITH CHECK (public.is_super_admin(auth.uid()));

CREATE POLICY "Super admins can update organizations"
ON public.organizations FOR UPDATE
USING (public.is_super_admin(auth.uid()));

CREATE POLICY "Super admins can delete organizations"
ON public.organizations FOR DELETE
USING (public.is_super_admin(auth.uid()));

-- 14. RLS policies for organization_users
CREATE POLICY "Super admins can view all org users"
ON public.organization_users FOR SELECT
USING (public.is_super_admin(auth.uid()));

CREATE POLICY "Users can view members of their orgs"
ON public.organization_users FOR SELECT
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Super admins can insert org users"
ON public.organization_users FOR INSERT
WITH CHECK (public.is_super_admin(auth.uid()));

CREATE POLICY "Org admins can insert users to their org"
ON public.organization_users FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.user_id = auth.uid()
      AND ou.organization_id = organization_users.organization_id
      AND ou.role IN ('org_admin', 'super_admin')
  )
);

CREATE POLICY "Super admins can update org users"
ON public.organization_users FOR UPDATE
USING (public.is_super_admin(auth.uid()));

CREATE POLICY "Org admins can update users of their org"
ON public.organization_users FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.user_id = auth.uid()
      AND ou.organization_id = organization_users.organization_id
      AND ou.role IN ('org_admin', 'super_admin')
  )
);

CREATE POLICY "Super admins can delete org users"
ON public.organization_users FOR DELETE
USING (public.is_super_admin(auth.uid()));

CREATE POLICY "Org admins can delete users of their org"
ON public.organization_users FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.user_id = auth.uid()
      AND ou.organization_id = organization_users.organization_id
      AND ou.role IN ('org_admin', 'super_admin')
  )
);

-- 15. Update projects RLS to include organization isolation
DROP POLICY IF EXISTS "Users can view their own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can create their own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can update their own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can delete their own projects" ON public.projects;

CREATE POLICY "Users can view projects of their organizations"
ON public.projects FOR SELECT
USING (
  public.is_super_admin(auth.uid()) OR
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
);

CREATE POLICY "Users can create projects in their organizations"
ON public.projects FOR INSERT
WITH CHECK (
  auth.uid() = user_id AND (
    public.is_super_admin(auth.uid()) OR
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

CREATE POLICY "Users can update projects of their organizations"
ON public.projects FOR UPDATE
USING (
  auth.uid() = user_id AND (
    public.is_super_admin(auth.uid()) OR
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

CREATE POLICY "Users can delete projects of their organizations"
ON public.projects FOR DELETE
USING (
  auth.uid() = user_id AND (
    public.is_super_admin(auth.uid()) OR
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

-- 16. Update data_sources RLS
DROP POLICY IF EXISTS "Users can view their own data sources" ON public.data_sources;
DROP POLICY IF EXISTS "Users can create their own data sources" ON public.data_sources;
DROP POLICY IF EXISTS "Users can update their own data sources" ON public.data_sources;
DROP POLICY IF EXISTS "Users can delete their own data sources" ON public.data_sources;

CREATE POLICY "Users can view data sources of their organizations"
ON public.data_sources FOR SELECT
USING (
  public.is_super_admin(auth.uid()) OR
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
);

CREATE POLICY "Users can create data sources in their organizations"
ON public.data_sources FOR INSERT
WITH CHECK (
  auth.uid() = user_id AND (
    public.is_super_admin(auth.uid()) OR
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

CREATE POLICY "Users can update data sources of their organizations"
ON public.data_sources FOR UPDATE
USING (
  auth.uid() = user_id AND (
    public.is_super_admin(auth.uid()) OR
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

CREATE POLICY "Users can delete data sources of their organizations"
ON public.data_sources FOR DELETE
USING (
  auth.uid() = user_id AND (
    public.is_super_admin(auth.uid()) OR
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  )
);

-- 17. Create trigger for updated_at on organizations
CREATE TRIGGER update_organizations_updated_at
BEFORE UPDATE ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();