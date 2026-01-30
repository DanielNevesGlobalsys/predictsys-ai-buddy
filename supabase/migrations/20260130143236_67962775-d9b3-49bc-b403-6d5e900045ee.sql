-- Add status to organization_users table
ALTER TABLE public.organization_users 
ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Add constraint to validate status values
ALTER TABLE public.organization_users 
ADD CONSTRAINT organization_users_status_check 
CHECK (status IN ('active', 'pending', 'blocked'));

-- Create the Sandbox organization if not exists
INSERT INTO public.organizations (id, name, slug, plan, max_projects, max_rows, max_storage_mb)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'PredictSys Sandbox',
  'predictsys-sandbox',
  'trial',
  3,
  10000,
  100
)
ON CONFLICT (id) DO NOTHING;

-- Create function to auto-assign new users to Sandbox org with pending status
CREATE OR REPLACE FUNCTION public.handle_new_user_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Check if user has any organization membership
  IF NOT EXISTS (SELECT 1 FROM public.organization_users WHERE user_id = NEW.id) THEN
    -- Assign to Sandbox org with pending status
    INSERT INTO public.organization_users (user_id, organization_id, role, status)
    VALUES (
      NEW.id,
      'b0000000-0000-0000-0000-000000000001',
      'viewer',
      'pending'
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Create trigger to run after profile creation
DROP TRIGGER IF EXISTS on_profile_created_assign_org ON public.profiles;
CREATE TRIGGER on_profile_created_assign_org
AFTER INSERT ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user_organization();

-- Update RLS policies to respect status
DROP POLICY IF EXISTS "Users can view projects of their organizations" ON public.projects;
CREATE POLICY "Users can view projects of their organizations" ON public.projects
FOR SELECT
USING (
  is_super_admin(auth.uid()) 
  OR (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_users 
      WHERE user_id = auth.uid() 
      AND status = 'active'
    )
  )
);

DROP POLICY IF EXISTS "Users can create projects in their organizations" ON public.projects;
CREATE POLICY "Users can create projects in their organizations" ON public.projects
FOR INSERT
WITH CHECK (
  (auth.uid() = user_id) 
  AND (
    is_super_admin(auth.uid()) 
    OR (
      organization_id IN (
        SELECT organization_id 
        FROM public.organization_users 
        WHERE user_id = auth.uid() 
        AND status = 'active'
        AND role IN ('super_admin', 'org_admin', 'analyst')
      )
    )
  )
);

DROP POLICY IF EXISTS "Users can update projects of their organizations" ON public.projects;
CREATE POLICY "Users can update projects of their organizations" ON public.projects
FOR UPDATE
USING (
  (auth.uid() = user_id) 
  AND (
    is_super_admin(auth.uid()) 
    OR (
      organization_id IN (
        SELECT organization_id 
        FROM public.organization_users 
        WHERE user_id = auth.uid() 
        AND status = 'active'
      )
    )
  )
);

DROP POLICY IF EXISTS "Users can delete projects of their organizations" ON public.projects;
CREATE POLICY "Users can delete projects of their organizations" ON public.projects
FOR DELETE
USING (
  (auth.uid() = user_id) 
  AND (
    is_super_admin(auth.uid()) 
    OR (
      organization_id IN (
        SELECT organization_id 
        FROM public.organization_users 
        WHERE user_id = auth.uid() 
        AND status = 'active'
      )
    )
  )
);

-- Add helper function to check user status
CREATE OR REPLACE FUNCTION public.user_has_active_org(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_users
    WHERE user_id = _user_id
      AND status = 'active'
  )
$$;