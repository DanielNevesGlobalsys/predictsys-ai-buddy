export interface GlobalKPIs {
  projects_created: number;
  datasets_connected: number;
  models_trained: number;
  predictions_run: number;
  segments_exported: number;
  jobs_error_count: number;
  active_organizations: number;
  total_organizations: number;
}

export interface HealthMetrics {
  avg_import_ms: number;
  avg_eda_ms: number;
  avg_train_ms: number;
  avg_predict_ms: number;
  total_errors: number;
}

export interface OrganizationUsage {
  organization_id: string;
  organization_name: string;
  plan: string;
  projects_created: number;
  datasets_connected: number;
  models_trained: number;
  predictions_run: number;
  segments_exported: number;
  jobs_error_count: number;
  active_users: number;
  total_users: number;
  last_event_at: string | null;
}

export interface DailyTrend {
  day: string;
  models_trained: number;
  predictions_run: number;
  jobs_error_count: number;
}

export interface AnalyticsData {
  success: boolean;
  date_range: { from: string; to: string };
  global_kpis: GlobalKPIs;
  health_metrics: HealthMetrics;
  organization_usage: OrganizationUsage[];
  daily_trend: DailyTrend[];
}

export interface TimeToValueGlobal {
  avg_project_to_dataset_hours: number;
  avg_dataset_to_training_hours: number;
  avg_training_to_prediction_hours: number;
  avg_prediction_to_export_hours: number;
  avg_total_time_to_value_hours: number;
  projects_with_dataset_pct: number;
  projects_with_training_pct: number;
  projects_with_prediction_pct: number;
  projects_with_export_pct: number;
  total_projects: number;
}

export interface TimeToValueByOrg {
  organization_id: string;
  organization_name: string;
  avg_project_to_dataset_hours: number | null;
  avg_dataset_to_training_hours: number | null;
  avg_training_to_prediction_hours: number | null;
  avg_prediction_to_export_hours: number | null;
  avg_total_time_to_value_hours: number | null;
  projects_with_dataset_pct: number | null;
  projects_with_training_pct: number | null;
  projects_with_prediction_pct: number | null;
  projects_with_export_pct: number | null;
  total_projects: number;
}

export interface TimeToValueData {
  success: boolean;
  date_range: { from: string; to: string };
  global_averages: TimeToValueGlobal;
  by_organization: TimeToValueByOrg[];
}

export type DateRange = "7" | "30" | "90";
