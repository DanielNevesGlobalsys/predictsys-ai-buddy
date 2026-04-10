import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { resolveGrain } from "@/lib/grainResolutionRules";
import { resolveTimeStrategy, resolveSplitStrategy, assessTemporalReadiness } from "@/lib/timeStrategyResolver";
import { buildGrainTimeResolution } from "@/lib/grainTimeScoring";
import type { GrainTimeResolution } from "@/types/grainResolution";

export function useGrainTimeResolution(projectId: string | undefined) {
  const [resolution, setResolution] = useState<GrainTimeResolution | null>(null);
  const [loading, setLoading] = useState(false);

  const resolve = useCallback(async (overrides?: {
    targetColumn?: string;
    problemType?: "classification" | "regression";
    entityKey?: string | null;
    timeColumn?: string | null;
    objective?: string;
  }) => {
    if (!projectId) return null;
    setLoading(true);

    try {
      // Fetch project data
      const [{ data: settings }, { data: cols }, { data: dsState }] = await Promise.all([
        supabase.from("project_settings").select("objective, entity_key, time_anchor_column, problem_type, target_column, dataset_build_mode, predictive_resolution_summary, ingestion_rows_detected, ingestion_cols_detected").eq("project_id", projectId).maybeSingle(),
        supabase.from("project_columns").select("column_name, inferred_type, null_percent, distinct_count").eq("project_id", projectId),
        supabase.from("project_dataset_state").select("row_count, col_count, source_type").eq("project_id", projectId).maybeSingle(),
      ]);

      const s = settings as any;
      const columns = ((cols || []) as unknown as Array<{ column_name: string; inferred_type: string; null_percent?: number; distinct_count?: number }>).map(c => ({
        column_name: c.column_name,
        inferred_type: c.inferred_type,
        null_percent: (c as any).null_percent as number | undefined,
        distinct_count: (c as any).distinct_count as number | undefined,
      }));

      const objective = overrides?.objective || s?.objective || "generic";
      const problemType = (overrides?.problemType || s?.problem_type || "classification") as "classification" | "regression";
      const entityKey = overrides?.entityKey !== undefined ? overrides.entityKey : (s?.entity_key || null);
      // CRITICAL: Prefer overrides.timeColumn over DB value — for new projects the DB is empty
      const timeColumn = overrides?.timeColumn !== undefined ? (overrides.timeColumn || s?.time_anchor_column || null) : (s?.time_anchor_column || null);
      const predictiveSummary = (s?.predictive_resolution_summary || {}) as Record<string, any>;
      const resolvedTargetColumn = overrides?.targetColumn || s?.target_column || predictiveSummary?.target || null;
      const forceTemporalAggregated = s?.dataset_build_mode === "temporal_aggregated"
        || predictiveSummary?.dataset_build_mode === "temporal_aggregated"
        || predictiveSummary?.aggregated_target_required === true
        || /^agg_/i.test(String(resolvedTargetColumn || ""));
      const totalRows = (dsState as any)?.row_count || s?.ingestion_rows_detected || 0;
      const totalCols = columns.length || (dsState as any)?.col_count || 0;

      // Detect data shape heuristic
      let dataShape = "unknown";
      let rowsPerEntity: number | null = null;
      if (entityKey && totalRows > 0) {
        const entityCol = columns.find(c => c.column_name === entityKey);
        if (entityCol?.distinct_count && entityCol.distinct_count > 0) {
          const ratio = totalRows / entityCol.distinct_count;
          rowsPerEntity = ratio;
          dataShape = ratio > 1.5 ? "multiple_rows_per_entity" : "one_row_per_entity";
        }
      }

      const autoFixes: string[] = [];

      // 1. Grain resolution
      const grainRes = resolveGrain({
        objective, problemType, entityKey, timeColumn,
        dataShape, rowsPerEntity, totalRows, totalCols,
      });

      // 2. Time strategy
      const timeRes = resolveTimeStrategy({
        columns, objective, existingTimeAnchor: timeColumn, grain: grainRes.recommended_grain,
      });

      if (timeRes.fallback_applied) autoFixes.push("TIME_FALLBACK_APPLIED");

      // 3. Split strategy
      const splitRes = resolveSplitStrategy({
        timeValid: timeRes.time_valid,
        timeRequired: timeRes.time_required,
        grain: grainRes.recommended_grain,
        entityKey,
        objective,
      });

      // 4. Temporal readiness
      const readiness = assessTemporalReadiness(
        timeRes.time_valid, timeRes.time_required, timeRes.time_column, columns,
      );

      // 5. Build combined resolution
      let result = buildGrainTimeResolution(grainRes, timeRes, splitRes, readiness, autoFixes);

      if (forceTemporalAggregated && entityKey && (timeRes.time_column || timeColumn)) {
        const resolvedTime = timeRes.time_column || timeColumn;
        result = {
          ...result,
          grain: {
            ...result.grain,
            recommended_grain: "entity_time",
            time_key: resolvedTime,
            aggregation_required: true,
            snapshot_required: true,
            aggregation_plan: result.grain.aggregation_plan || {
              level: `${entityKey}_periodo`,
              method: "group_by_entity_time",
            },
            grain_reasoning: [...result.grain.grain_reasoning, "Fluxo agro agregado preservado a partir do SSOT/PRE."],
            confidence: Math.max(result.grain.confidence, 0.9),
          },
          split: {
            ...result.split,
            recommended_split: "temporal",
            split_reasoning: [...result.split.split_reasoning, "Split temporal forçado para manter coerência com target agregado oficial."],
            confidence: Math.max(result.split.confidence, 0.9),
          },
          build_plan: {
            ...result.build_plan,
            use_original_rows: false,
            requires_aggregation: true,
            requires_snapshots: true,
            requires_temporal_features: true,
            builder_mode: "temporal_aggregated",
            builder_reasoning: [...result.build_plan.builder_reasoning, "Builder temporal agregado preservado pelo SSOT/PRE."],
          },
          auto_fixes_applied: Array.from(new Set([...result.auto_fixes_applied, "FORCE_TEMPORAL_AGGREGATED_FROM_SSOT"])),
        };
      }

      setResolution(result);

      // 6. Persist to project_settings
      await supabase.from("project_settings").update({
        recommended_grain: result.grain.recommended_grain,
        grain_confidence: result.grain.confidence,
        recommended_time_column: result.time.time_column,
        time_strategy_confidence: result.time.confidence,
        recommended_split_strategy: result.split.recommended_split,
        dataset_build_mode: result.build_plan.builder_mode,
        temporal_readiness_state: result.temporal_readiness.status,
        updated_at: new Date().toISOString(),
      } as any).eq("project_id", projectId);

      console.log("[useGrainTimeResolution] Resolved:", {
        grain: grainRes.recommended_grain,
        time: timeRes.time_column,
        split: splitRes.recommended_split,
        confidence: result.overall_confidence,
      });

      return result;
    } catch (err) {
      console.error("[useGrainTimeResolution] Error:", err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  return { resolution, loading, resolve };
}
