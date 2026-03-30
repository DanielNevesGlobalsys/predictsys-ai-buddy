// ═══════════════════════════════════════════════════════════════════
// Grain Resolution Engine + Time Strategy Resolver — Core Types
// ═══════════════════════════════════════════════════════════════════

export type RecommendedGrain =
  | "original_row"
  | "entity"
  | "entity_time"
  | "entity_event"
  | "entity_product_time"
  | "custom_aggregated";

export type TemporalColumnType =
  | "snapshot_date"
  | "event_date"
  | "reference_date"
  | "creation_date"
  | "unknown";

export type TemporalMode =
  | "snapshot_supervised"
  | "event_supervised"
  | "time_series"
  | "atemporal";

export type SplitStrategy =
  | "temporal"
  | "stratified"
  | "random"
  | "grouped_by_entity"
  | "blocked_temporal";

export type BuilderMode =
  | "row_level"
  | "entity_level"
  | "entity_time"
  | "temporal_aggregated"
  | "event_supervised";

// ─── Grain Resolution ──────────────────────────────────────────

export interface GrainResolution {
  recommended_grain: RecommendedGrain;
  entity_key: string[];
  time_key: string | null;
  grain_reasoning: string[];
  aggregation_required: boolean;
  snapshot_required: boolean;
  aggregation_plan: {
    level: string | null;
    method: string | null;
  } | null;
  confidence: number;
}

// ─── Time Strategy ─────────────────────────────────────────────

export interface TimeStrategy {
  time_column: string | null;
  time_column_type: TemporalColumnType;
  time_valid: boolean;
  time_required: boolean;
  temporal_mode: TemporalMode;
  window_days: number | null;
  time_reasoning: string[];
  fallback_applied: boolean;
  confidence: number;
}

// ─── Split Recommendation ──────────────────────────────────────

export interface SplitRecommendation {
  recommended_split: SplitStrategy;
  split_reasoning: string[];
  fallback_split: SplitStrategy | null;
  fallback_reason: string | null;
  confidence: number;
}

// ─── Dataset Build Plan ────────────────────────────────────────

export interface DatasetBuildPlan {
  use_original_rows: boolean;
  requires_aggregation: boolean;
  requires_snapshots: boolean;
  requires_temporal_features: boolean;
  builder_mode: BuilderMode;
  builder_reasoning: string[];
}

// ─── Temporal Readiness ────────────────────────────────────────

export interface TemporalReadiness {
  has_valid_time: boolean;
  time_coverage_pct: number | null;
  time_range_days: number | null;
  issues: string[];
  status: "ready" | "partial" | "unavailable";
}

// ─── Combined Grain+Time Resolution ───────────────────────────

export interface GrainTimeResolution {
  grain: GrainResolution;
  time: TimeStrategy;
  split: SplitRecommendation;
  build_plan: DatasetBuildPlan;
  temporal_readiness: TemporalReadiness;
  overall_confidence: number;
  auto_fixes_applied: string[];
}
