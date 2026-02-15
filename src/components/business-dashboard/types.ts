// Types for Business Dashboard

export interface Prediction {
  id: string;
  project_id: string;
  user_id: string;
  entity_id: string;
  entity_type: string;
  reference_date: string;
  prediction_date: string;
  horizon_days: number;
  problem_type: 'classification' | 'regression' | 'time_series';
  problem_context: string | null;
  probability_event: number | null;
  predicted_class: string | null;
  predicted_value: number | null;
  segment: string | null;
  age_group: string | null;
  region: string | null;
  state: string | null;
  city: string | null;
  product_category: string | null;
  channel: string | null;
  campaign: string | null;
  cohort: string | null;
  potential_value: number | null;
  average_ticket: number | null;
  lifetime_value: number | null;
  metadata: Record<string, unknown>;
  batch_id: string | null;
  is_latest: boolean;
  created_at: string;
  updated_at: string;
}

export interface DashboardFilters {
  dataset: 'latest' | 'all';
  dateRange: { from: Date | null; to: Date | null };
  horizon: 30 | 60 | 90 | 180 | 365;
  segmentField: string | null;
  segmentValue: string | null;
  viewMode: 'risk' | 'opportunity';
}

export interface KPIData {
  totalEntities: number;
  highProbabilityCount: number;
  highProbabilityPercent: number;
  expectedEvents: number;
  expectedEventsPercent: number;
  financialImpact: number;
  coveragePercent: number;
  lastUpdateDate: string | null;
  daysSinceUpdate: number | null;
  // Regression-specific fields
  predictedTotalValue: number;
  predictedAvgValue: number;
}

export interface SegmentationBand {
  range: string;
  min: number;
  max: number;
  count: number;
  percent: number;
  avgPotentialValue: number | null;
  totalValue?: number;
}

export interface GroupSegmentation {
  group: string;
  count: number;
  avgProbability: number | null;
  avgValue: number | null;
  highProbabilityPercent: number;
}

export interface TimeProjection {
  period: string;
  expectedEvents: number;
  financialImpact: number;
}

export interface ActionableEntity {
  entityId: string;
  probability: number | null;
  predictedValue: number | null;
  segment: string | null;
  region: string | null;
  potentialValue: number | null;
  probabilityBand: string;
}

export interface CohortComparison {
  cohort: string;
  avgProbability: number | null;
  avgValue: number | null;
  count: number;
  highProbabilityPercent: number;
}

export interface SimulationResult {
  threshold: number;
  percentActioned: number;
  expectedEventsCaptured: number;
  financialImpact: number;
  entitiesToAction: number;
}

export interface AIInsight {
  type: 'summary' | 'opportunities' | 'risks' | 'actions';
  content: string;
}

export interface BusinessDashboardData {
  predictions: Prediction[];
  kpis: KPIData;
  segmentationBands: SegmentationBand[];
  groupSegmentation: GroupSegmentation[];
  timeProjections: TimeProjection[];
  availableSegmentFields: string[];
  confidenceScore: number | null;
  confidenceInputs: {
    predictability_score: number | null;
    coverage_pct: number | null;
    missing_feature_pct: number | null;
    sanity_fail: boolean;
  } | null;
  recommendedThreshold: number | null;
  staleResults: boolean;
  selectionVersionScored: number | null;
  selectionVersionCurrent: number | null;
}

// Executive Report types
export interface ExportGate {
  gate: string;
  status: 'BLOCK' | 'WARN';
  message: string;
}

export interface ExportCTA {
  label: string;
  action: string;
  step?: number;
}

export interface ExecutiveReportResponse {
  success: boolean;
  report_id?: string;
  signed_url?: string;
  file_path?: string;
  generated_at?: string;
  selection_version_scored?: number | null;
  selection_version_current?: number | null;
  confidence_score?: number | null;
  stale_results?: boolean;
  total_entities?: number;
  // Error fields
  status?: string;
  error_code?: string;
  error_friendly?: string;
  error?: string;
  gates?: ExportGate[];
  ctas?: ExportCTA[];
  selectionVersionCurrent: number | null;
}

export const PROBLEM_CONTEXT_LABELS: Record<string, { title: string; subtitle: string }> = {
  churn: {
    title: 'businessDashboard.contextLabels.churn.title',
    subtitle: 'businessDashboard.contextLabels.churn.subtitle'
  },
  propensao_compra: {
    title: 'businessDashboard.contextLabels.purchase.title',
    subtitle: 'businessDashboard.contextLabels.purchase.subtitle'
  },
  inadimplencia: {
    title: 'businessDashboard.contextLabels.default.title',
    subtitle: 'businessDashboard.contextLabels.default.subtitle'
  },
  demanda: {
    title: 'businessDashboard.contextLabels.demand.title',
    subtitle: 'businessDashboard.contextLabels.demand.subtitle'
  },
  ltv: {
    title: 'businessDashboard.contextLabels.ltv.title',
    subtitle: 'businessDashboard.contextLabels.ltv.subtitle'
  },
  credito: {
    title: 'businessDashboard.contextLabels.credit.title',
    subtitle: 'businessDashboard.contextLabels.credit.subtitle'
  }
};
