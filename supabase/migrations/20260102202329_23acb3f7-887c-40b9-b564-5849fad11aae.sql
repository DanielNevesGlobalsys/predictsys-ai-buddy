-- Create enum for schedule frequency
CREATE TYPE public.schedule_frequency AS ENUM (
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'semiannual',
  'yearly',
  'specific_date'
);

-- Create table for prediction schedules
CREATE TABLE public.project_prediction_schedules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  model_id UUID REFERENCES public.project_models(id) ON DELETE SET NULL,
  frequency schedule_frequency NOT NULL DEFAULT 'monthly',
  cron_expression TEXT,
  start_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  next_run_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  enabled BOOLEAN NOT NULL DEFAULT false,
  send_email_to TEXT NOT NULL,
  run_predictions BOOLEAN NOT NULL DEFAULT true,
  run_retraining BOOLEAN NOT NULL DEFAULT false,
  day_of_week INTEGER CHECK (day_of_week >= 0 AND day_of_week <= 6),
  day_of_month INTEGER CHECK (day_of_month >= 1 AND day_of_month <= 31),
  time_of_day TIME NOT NULL DEFAULT '08:00:00',
  last_run_at TIMESTAMP WITH TIME ZONE,
  last_run_status TEXT CHECK (last_run_status IN ('success', 'error', 'pending', 'running')),
  last_run_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.project_prediction_schedules ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view schedules of their own projects"
ON public.project_prediction_schedules
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE projects.id = project_prediction_schedules.project_id
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can create schedules for their own projects"
ON public.project_prediction_schedules
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE projects.id = project_prediction_schedules.project_id
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update schedules of their own projects"
ON public.project_prediction_schedules
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE projects.id = project_prediction_schedules.project_id
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete schedules of their own projects"
ON public.project_prediction_schedules
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.projects
    WHERE projects.id = project_prediction_schedules.project_id
    AND projects.user_id = auth.uid()
  )
);

-- Create trigger for updated_at
CREATE TRIGGER update_project_prediction_schedules_updated_at
  BEFORE UPDATE ON public.project_prediction_schedules
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- Create index for efficient querying by next_run_at
CREATE INDEX idx_prediction_schedules_next_run ON public.project_prediction_schedules(enabled, next_run_at);