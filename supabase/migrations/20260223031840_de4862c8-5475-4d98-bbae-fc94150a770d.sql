
-- TDE Etapa F: Human-in-the-loop / Micro-rotulagem com Active Learning

-- 1.1 Tabela de rótulos humanos
CREATE TABLE IF NOT EXISTS public.project_human_labels (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'entity',
  reference_date TIMESTAMPTZ,
  label SMALLINT NOT NULL,
  label_status TEXT NOT NULL DEFAULT 'yes',
  notes TEXT,
  round_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, entity_id, round_id)
);

CREATE INDEX idx_human_labels_project ON public.project_human_labels(project_id);
CREATE INDEX idx_human_labels_round ON public.project_human_labels(project_id, round_id);

ALTER TABLE public.project_human_labels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view human labels in their orgs"
  ON public.project_human_labels FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.organization_users ou ON ou.organization_id = p.organization_id
      WHERE p.id = project_human_labels.project_id AND ou.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert human labels"
  ON public.project_human_labels FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own human labels"
  ON public.project_human_labels FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own human labels"
  ON public.project_human_labels FOR DELETE
  USING (auth.uid() = user_id);

-- 1.2 Novos campos JSONB em project_settings
ALTER TABLE public.project_settings
ADD COLUMN IF NOT EXISTS human_label_config JSONB DEFAULT NULL,
ADD COLUMN IF NOT EXISTS human_label_result JSONB DEFAULT NULL;
