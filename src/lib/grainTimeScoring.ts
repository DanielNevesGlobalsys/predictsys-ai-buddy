// ═══════════════════════════════════════════════════════════════════
// Grain + Time Scoring — Confidence per axis
// ═══════════════════════════════════════════════════════════════════

import type {
  GrainResolution,
  TimeStrategy,
  SplitRecommendation,
  DatasetBuildPlan,
  GrainTimeResolution,
  TemporalReadiness,
  BuilderMode,
  RecommendedGrain,
} from "@/types/grainResolution";

export function buildDatasetPlan(
  grain: GrainResolution,
  time: TimeStrategy,
): DatasetBuildPlan {
  const reasoning: string[] = [];
  let mode: BuilderMode = "row_level";

  if (grain.aggregation_required && time.time_valid) {
    mode = "temporal_aggregated";
    reasoning.push("Dataset bruto requer agregação temporal.");
  } else if (grain.aggregation_required) {
    mode = "entity_level";
    reasoning.push("Agregação por entidade sem temporalidade.");
  } else if (grain.recommended_grain === "entity_time" && time.time_valid) {
    mode = "entity_time";
    reasoning.push("Grain entity_time com coluna temporal válida.");
  } else if (grain.recommended_grain === "entity_event") {
    mode = "event_supervised";
    reasoning.push("Supervisão por evento transacional.");
  } else {
    mode = "row_level";
    reasoning.push("Dataset row-level sem agregação.");
  }

  return {
    use_original_rows: mode === "row_level" || mode === "event_supervised",
    requires_aggregation: grain.aggregation_required,
    requires_snapshots: grain.snapshot_required,
    requires_temporal_features: time.time_valid && ["entity_time", "temporal_aggregated"].includes(mode),
    builder_mode: mode,
    builder_reasoning: reasoning,
  };
}

export function computeGrainTimeOverallConfidence(
  grain: GrainResolution,
  time: TimeStrategy,
  split: SplitRecommendation,
): number {
  const weights = { grain: 0.35, time: 0.35, split: 0.3 };
  const overall =
    grain.confidence * weights.grain +
    time.confidence * weights.time +
    split.confidence * weights.split;
  return Math.round(overall * 100) / 100;
}

export function buildGrainTimeResolution(
  grain: GrainResolution,
  time: TimeStrategy,
  split: SplitRecommendation,
  temporalReadiness: TemporalReadiness,
  autoFixes: string[],
): GrainTimeResolution {
  const buildPlan = buildDatasetPlan(grain, time);
  const overall = computeGrainTimeOverallConfidence(grain, time, split);

  return {
    grain,
    time,
    split,
    build_plan: buildPlan,
    temporal_readiness: temporalReadiness,
    overall_confidence: overall,
    auto_fixes_applied: autoFixes,
  };
}
