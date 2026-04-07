
-- LIS AI OS: Agent execution persistence table
CREATE TABLE public.lis_agent_executions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  agent_name TEXT NOT NULL,
  stage TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'auto' CHECK (execution_mode IN ('auto', 'assisted', 'shadow')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'warning', 'blocked', 'failed')),
  confidence NUMERIC(4,3),
  context_version TEXT,
  input_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
  project_context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision JSONB DEFAULT '{}'::jsonb,
  reasoning_summary JSONB DEFAULT '[]'::jsonb,
  warnings JSONB DEFAULT '[]'::jsonb,
  blocking_issues JSONB DEFAULT '[]'::jsonb,
  actions_recommended JSONB DEFAULT '[]'::jsonb,
  input_hash TEXT,
  model_used TEXT,
  duration_ms INTEGER,
  triggered_by TEXT DEFAULT 'system',
  raw_ai_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX idx_lis_agent_exec_project ON public.lis_agent_executions(project_id, created_at DESC);
CREATE INDEX idx_lis_agent_exec_agent ON public.lis_agent_executions(agent_name, stage);

-- RLS
ALTER TABLE public.lis_agent_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view agent executions for their org projects"
  ON public.lis_agent_executions
  FOR SELECT
  TO authenticated
  USING (
    public.user_belongs_to_org(auth.uid(), organization_id)
  );

CREATE POLICY "Service role full access to agent executions"
  ON public.lis_agent_executions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
