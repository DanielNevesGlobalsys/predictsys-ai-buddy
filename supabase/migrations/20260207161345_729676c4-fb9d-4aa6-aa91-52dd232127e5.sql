
-- Table: project_ai_context
-- Stores cumulative AI context per project across all pipeline stages
CREATE TABLE public.project_ai_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL UNIQUE REFERENCES public.projects(id) ON DELETE CASCADE,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX idx_project_ai_context_org ON public.project_ai_context(organization_id);
CREATE INDEX idx_project_ai_context_project ON public.project_ai_context(project_id);

-- Enable RLS
ALTER TABLE public.project_ai_context ENABLE ROW LEVEL SECURITY;

-- RLS Policies: multi-tenant isolation
CREATE POLICY "Users can view AI context of their own projects"
ON public.project_ai_context
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_ai_context.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users can insert AI context for their own projects"
ON public.project_ai_context
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_ai_context.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update AI context of their own projects"
ON public.project_ai_context
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_ai_context.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete AI context of their own projects"
ON public.project_ai_context
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_ai_context.project_id
    AND p.user_id = auth.uid()
  )
);

CREATE POLICY "Service role full access to AI context"
ON public.project_ai_context
FOR ALL
USING (auth.role() = 'service_role');

CREATE POLICY "Super admins can view all AI context"
ON public.project_ai_context
FOR SELECT
USING (is_super_admin(auth.uid()));
