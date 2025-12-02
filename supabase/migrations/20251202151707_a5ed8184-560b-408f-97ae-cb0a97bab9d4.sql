-- Drop the existing constraint
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_check;

-- Add new constraint with all required status values
ALTER TABLE public.projects ADD CONSTRAINT projects_status_check 
CHECK (status = ANY (ARRAY[
  'draft'::text, 
  'configuring'::text, 
  'data_uploaded'::text,
  'eda_complete'::text,
  'training'::text, 
  'evaluated'::text, 
  'deployed'::text,
  'production'::text
]));