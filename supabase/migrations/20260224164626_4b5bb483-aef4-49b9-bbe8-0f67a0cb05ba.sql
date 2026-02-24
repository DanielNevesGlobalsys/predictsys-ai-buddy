
-- Table for persisting dataset sample for simple-mode training
CREATE TABLE IF NOT EXISTS public.project_dataset_sample (
  project_id UUID PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  sample_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  sample_rows INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.project_dataset_sample ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view samples of their org projects"
  ON public.project_dataset_sample FOR SELECT
  USING (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Users can insert samples for their org projects"
  ON public.project_dataset_sample FOR INSERT
  WITH CHECK (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Users can update samples for their org projects"
  ON public.project_dataset_sample FOR UPDATE
  USING (public.user_can_access_project(auth.uid(), project_id));

CREATE POLICY "Service role full access to dataset samples"
  ON public.project_dataset_sample FOR ALL
  USING (auth.role() = 'service_role');
