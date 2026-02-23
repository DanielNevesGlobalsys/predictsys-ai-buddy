
ALTER TABLE public.project_settings
  ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT 'generic',
  ADD COLUMN IF NOT EXISTS industry_source text NOT NULL DEFAULT 'lys',
  ADD COLUMN IF NOT EXISTS segment text,
  ADD COLUMN IF NOT EXISTS segment_source text;
