// ═══════════════════════════════════════════════════════════════════
// Predictive Resolution Engine (PRE) — Core Types
// Transforms IntentContractV3 + EDA + TDE into executable ML config
// ═══════════════════════════════════════════════════════════════════

export type PREMode = "shadow" | "assisted" | "auto";

export type TargetMode = "explicit" | "derived" | "weak" | "blocked";

export type GrainType =
  | "entity_time"
  | "entity_product_time"
  | "entity_event"
  | "original_row"
  | "aggregated";

export type TemporalStrategy =
  | "snapshot"
  | "multi_period"
  | "sliding_window"
  | "none";

export type ResolutionStatus =
  | "pending"
  | "resolved"
  | "accepted"
  | "rejected"
  | "promoted";

// ─── Problem Definition ────────────────────────────────────────

export interface ProblemDefinition {
  problem_type: "classification" | "regression";
  business_mode: string;
  entity: {
    entity_key: string | null;
    grain: GrainType;
    entity_label: string;
  };
  dataset_shape_detected: string;
  time_anchor: string | null;
  horizon_days: number;
}

// ─── Target Definition ─────────────────────────────────────────

export interface TargetCandidate {
  column: string;
  score: number;
  mode: TargetMode;
  reasoning: string;
  business_fit: number;
  semantic_fit: number;
  temporal_fit: number;
  trainability_fit: number;
  leakage_penalty: number;
}

export interface TargetDefinition {
  mode: TargetMode;
  target_name: string | null;
  target_source_column: string | null;
  target_rule: string | null;
  target_kind: "binary" | "multiclass" | "continuous" | "unknown";
  target_confidence: number;
  target_reasoning: string;
  alternatives: TargetCandidate[];
}

// ─── Dataset Strategy ──────────────────────────────────────────

export interface DatasetStrategy {
  needs_aggregation: boolean;
  aggregation_level: string | null;
  snapshot_required: boolean;
  temporal_strategy: TemporalStrategy;
  multi_table_strategy: string | null;
  split_suggestion: string;
}

// ─── Feature Plan ──────────────────────────────────────────────

export interface FeaturePlan {
  include_features: string[];
  exclude_features: string[];
  blocked_features: string[];
  leakage_flags: string[];
  feature_reasoning: string;
}

// ─── Validation ────────────────────────────────────────────────

export interface ResolutionValidation {
  training_ready: boolean;
  issues_detected: ResolutionIssue[];
  blocking_errors: string[];
}

export interface ResolutionIssue {
  code: string;
  severity: "block" | "warn" | "info";
  message: string;
  suggestion?: string;
}

// ─── Explanation ───────────────────────────────────────────────

export interface ResolutionExplanation {
  why_this_problem: string;
  why_this_target: string;
  why_this_grain: string;
  main_risks: string[];
}

// ─── Confidence ────────────────────────────────────────────────

export interface ResolutionConfidence {
  overall: number;
  scores: {
    problem_fit: number;
    target_fit: number;
    grain_fit: number;
    time_fit: number;
  };
}

// ─── Full Resolution Object ────────────────────────────────────

export interface PredictiveResolution {
  version: number;
  mode: PREMode;
  problem_definition: ProblemDefinition;
  target_definition: TargetDefinition;
  dataset_strategy: DatasetStrategy;
  feature_plan: FeaturePlan;
  validation: ResolutionValidation;
  explanation: ResolutionExplanation;
  confidence: ResolutionConfidence;
  // Metadata
  inputs_used: string[];
  rules_triggered: string[];
  created_at: string;
}

// ─── DB Row ────────────────────────────────────────────────────

export interface PredictiveResolutionRow {
  id: string;
  project_id: string;
  organization_id: string;
  resolution_version: number;
  intent_contract_version: number;
  selection_version: number;
  mode: PREMode;
  resolution_json: PredictiveResolution;
  overall_confidence: number;
  status: ResolutionStatus;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── PRE Input Bundle ──────────────────────────────────────────

export interface PREInputBundle {
  project_id: string;
  organization_id: string;
  mode: PREMode;
  intent_contract_v3?: any;
  business_intent_contract?: any;
  target_intent_resolution?: any;
  eda_profile_json?: any;
  project_columns?: Array<{ column_name: string; inferred_type: string; [k: string]: any }>;
  tde_profile?: any;
  dataset_sample?: any;
  label_templates?: any;
  model_selection?: any;
  modeling_contract?: any;
  dataset_state?: any;
}
