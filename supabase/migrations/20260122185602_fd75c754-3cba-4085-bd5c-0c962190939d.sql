-- Create a default organization for GlobalSys
INSERT INTO public.organizations (id, name, slug, plan, max_projects, max_rows, max_storage_mb)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'GlobalSys - Demo',
  'globalsys-demo',
  'enterprise',
  100,
  100000000,
  50000
)
ON CONFLICT (slug) DO NOTHING;

-- Update existing projects to belong to the default organization
UPDATE public.projects 
SET organization_id = 'a0000000-0000-0000-0000-000000000001'
WHERE organization_id IS NULL;

-- Update existing data_sources to belong to the default organization  
UPDATE public.data_sources 
SET organization_id = 'a0000000-0000-0000-0000-000000000001'
WHERE organization_id IS NULL;

-- Add all existing users as super_admins in the default organization
INSERT INTO public.organization_users (organization_id, user_id, role)
SELECT 
  'a0000000-0000-0000-0000-000000000001',
  p.id,
  'super_admin'::app_role
FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM public.organization_users ou 
  WHERE ou.user_id = p.id 
  AND ou.organization_id = 'a0000000-0000-0000-0000-000000000001'
);