-- Table for business configuration per project
CREATE TABLE public.project_business_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  average_sale_value NUMERIC(15,2) DEFAULT 0,
  average_margin_percent NUMERIC(5,2) DEFAULT 0,
  cost_per_contact NUMERIC(15,2) DEFAULT 0,
  impact_window_days INTEGER DEFAULT 30,
  baseline_conversion_percent NUMERIC(5,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id)
);

-- Table for tracking business actions/campaigns
CREATE TABLE public.project_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  action_name TEXT NOT NULL,
  action_type TEXT NOT NULL, -- 'whatsapp', 'email', 'sales_force', 'push', 'sms', 'other'
  segment_used TEXT, -- e.g., "high_risk_churn_30d"
  target_customers INTEGER DEFAULT 0,
  start_date DATE NOT NULL,
  end_date DATE,
  expected_conversion_percent NUMERIC(5,2) DEFAULT 0,
  observed_conversion_percent NUMERIC(5,2),
  success_metric TEXT, -- e.g., "% que voltou a comprar em 30 dias"
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'planned', -- 'planned', 'running', 'completed', 'cancelled'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.project_business_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_actions ENABLE ROW LEVEL SECURITY;

-- RLS policies for project_business_config
CREATE POLICY "Users can view config of their own projects"
ON public.project_business_config FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_business_config.project_id AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can insert config for their own projects"
ON public.project_business_config FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_business_config.project_id AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can update config of their own projects"
ON public.project_business_config FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_business_config.project_id AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete config of their own projects"
ON public.project_business_config FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_business_config.project_id AND projects.user_id = auth.uid()
));

-- RLS policies for project_actions
CREATE POLICY "Users can view actions of their own projects"
ON public.project_actions FOR SELECT
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_actions.project_id AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can insert actions for their own projects"
ON public.project_actions FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_actions.project_id AND projects.user_id = auth.uid()
) AND user_id = auth.uid());

CREATE POLICY "Users can update actions of their own projects"
ON public.project_actions FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_actions.project_id AND projects.user_id = auth.uid()
));

CREATE POLICY "Users can delete actions of their own projects"
ON public.project_actions FOR DELETE
USING (EXISTS (
  SELECT 1 FROM projects WHERE projects.id = project_actions.project_id AND projects.user_id = auth.uid()
));

-- Trigger for updated_at
CREATE TRIGGER update_project_business_config_updated_at
BEFORE UPDATE ON public.project_business_config
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER update_project_actions_updated_at
BEFORE UPDATE ON public.project_actions
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();