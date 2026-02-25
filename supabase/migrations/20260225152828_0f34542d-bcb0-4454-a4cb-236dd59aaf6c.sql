-- Make industry nullable and remove 'generic' default
ALTER TABLE public.project_settings ALTER COLUMN industry DROP NOT NULL;
ALTER TABLE public.project_settings ALTER COLUMN industry DROP DEFAULT;

-- Clean up existing 'generic' values to NULL
UPDATE public.project_settings SET industry = NULL WHERE industry = 'generic';
UPDATE public.project_settings SET segment = NULL WHERE segment IN ('generic', 'geral');