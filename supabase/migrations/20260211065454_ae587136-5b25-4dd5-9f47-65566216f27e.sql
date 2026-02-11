
-- Create schedule type enum
DO $$ BEGIN
  CREATE TYPE public.schedule_type AS ENUM ('daily','weekly','monthly','interval_hours');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.schedule_mode AS ENUM ('full','incremental');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.schedule_run_status AS ENUM ('RUNNING','DONE','BLOCKED','ERROR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create project_schedules table (1 row per project)
CREATE TABLE IF NOT EXISTS public.project_schedules (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE PRIMARY KEY,
  is_enabled boolean NOT NULL DEFAULT false,
  schedule_type public.schedule_type NOT NULL DEFAULT 'daily',
  interval_hours integer,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  hour integer NOT NULL DEFAULT 8 CHECK (hour >= 0 AND hour <= 23),
  minute integer NOT NULL DEFAULT 0 CHECK (minute >= 0 AND minute <= 59),
  day_of_week integer CHECK (day_of_week >= 0 AND day_of_week <= 6),
  day_of_month integer CHECK (day_of_month >= 1 AND day_of_month <= 28),
  mode public.schedule_mode NOT NULL DEFAULT 'full',
  pause_on_blocked boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view schedules of their projects"
  ON public.project_schedules FOR SELECT
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = project_schedules.project_id AND p.user_id = auth.uid()));

CREATE POLICY "Users can insert schedules for their projects"
  ON public.project_schedules FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.id = project_schedules.project_id AND p.user_id = auth.uid()));

CREATE POLICY "Users can update schedules of their projects"
  ON public.project_schedules FOR UPDATE
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = project_schedules.project_id AND p.user_id = auth.uid()));

CREATE POLICY "Users can delete schedules of their projects"
  ON public.project_schedules FOR DELETE
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = project_schedules.project_id AND p.user_id = auth.uid()));

CREATE POLICY "Service role full access to schedules"
  ON public.project_schedules FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Create project_schedule_runs table
CREATE TABLE IF NOT EXISTS public.project_schedule_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  status public.schedule_run_status NOT NULL DEFAULT 'RUNNING',
  scoring_job_id uuid,
  blocked_reason_code text,
  diagnostics jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_schedule_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view schedule runs of their projects"
  ON public.project_schedule_runs FOR SELECT
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = project_schedule_runs.project_id AND p.user_id = auth.uid()));

CREATE POLICY "Service role full access to schedule runs"
  ON public.project_schedule_runs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Add updated_at trigger
CREATE TRIGGER update_project_schedules_updated_at
  BEFORE UPDATE ON public.project_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Update cascade delete function to include new tables
CREATE OR REPLACE FUNCTION public.delete_project_cascade(p_project_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_deleted_predictions int := 0;
  v_batch int;
  v_model_ids uuid[];
BEGIN
  SELECT array_agg(id) INTO v_model_ids FROM project_models WHERE project_id = p_project_id;

  IF v_model_ids IS NOT NULL AND array_length(v_model_ids, 1) > 0 THEN
    DELETE FROM project_feature_importances WHERE project_model_id = ANY(v_model_ids);
    DELETE FROM project_model_metrics WHERE project_model_id = ANY(v_model_ids);
    DELETE FROM project_model_insights WHERE model_id = ANY(v_model_ids);
  END IF;

  DELETE FROM project_schedule_runs WHERE project_id = p_project_id;
  DELETE FROM project_schedules WHERE project_id = p_project_id;
  DELETE FROM project_score_reports WHERE project_id = p_project_id;
  DELETE FROM project_scoring_jobs WHERE project_id = p_project_id;
  DELETE FROM project_model_insights WHERE project_id = p_project_id;
  DELETE FROM project_prediction_schedules WHERE project_id = p_project_id;
  DELETE FROM project_models WHERE project_id = p_project_id;
  DELETE FROM project_chat_messages WHERE project_id = p_project_id;
  DELETE FROM project_numeric_stats WHERE project_id = p_project_id;
  DELETE FROM project_categorical_stats WHERE project_id = p_project_id;
  DELETE FROM project_columns WHERE project_id = p_project_id;
  DELETE FROM project_column_inference WHERE project_id = p_project_id;
  DELETE FROM project_eda_insights WHERE project_id = p_project_id;
  DELETE FROM project_eda_snapshots WHERE project_id = p_project_id;
  DELETE FROM project_ai_context WHERE project_id = p_project_id;
  DELETE FROM project_ai_memory WHERE project_id = p_project_id;
  DELETE FROM project_data_contract WHERE project_id = p_project_id;
  DELETE FROM project_features WHERE project_id = p_project_id;
  DELETE FROM project_business_config WHERE project_id = p_project_id;
  DELETE FROM project_actions WHERE project_id = p_project_id;
  DELETE FROM project_data_ingestion_logs WHERE project_id = p_project_id;
  DELETE FROM project_problem_inference WHERE project_id = p_project_id;
  DELETE FROM project_modeling_contracts WHERE project_id = p_project_id;
  DELETE FROM project_modeling_datasets WHERE project_id = p_project_id;
  DELETE FROM project_dataset_state WHERE project_id = p_project_id;
  DELETE FROM project_model_selection WHERE project_id = p_project_id;
  DELETE FROM project_settings WHERE project_id = p_project_id;
  DELETE FROM export_jobs WHERE project_id = p_project_id;

  LOOP
    DELETE FROM predictions WHERE id IN (
      SELECT id FROM predictions WHERE project_id = p_project_id LIMIT 5000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_deleted_predictions := v_deleted_predictions + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;

  DELETE FROM import_manifests WHERE project_id = p_project_id;
  DELETE FROM import_jobs WHERE project_id = p_project_id;
  DELETE FROM project_datasets WHERE project_id = p_project_id;

  UPDATE platform_events SET project_id = NULL WHERE project_id = p_project_id;
  UPDATE audit_logs SET project_id = NULL WHERE project_id = p_project_id;

  DELETE FROM projects WHERE id = p_project_id;

  RETURN jsonb_build_object('success', true, 'predictions_deleted', v_deleted_predictions);
END;
$function$;
