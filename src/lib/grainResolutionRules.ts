// ═══════════════════════════════════════════════════════════════════
// Grain Resolution Engine — Deterministic Rules
// ═══════════════════════════════════════════════════════════════════

import type { GrainResolution, RecommendedGrain } from "@/types/grainResolution";

const TEMPORAL_OBJECTIVES = [
  "churn", "turnover", "no_show", "default_risk", "inadimplencia",
  "propensity", "demand_forecast", "revenue", "value_forecast",
  "lifetime_value", "price_optimization",
];

const TRANSACTIONAL_OBJECTIVES = [
  "fraud", "anomaly", "anomaly_detection", "risk_scoring",
];

interface GrainInput {
  objective: string;
  problemType: "classification" | "regression";
  entityKey: string | null;
  timeColumn: string | null;
  dataShape: string;
  rowsPerEntity: number | null; // avg rows per entity if known
  totalRows: number;
  totalCols: number;
}

export function resolveGrain(input: GrainInput): GrainResolution {
  const obj = (input.objective || "").toLowerCase();
  const reasoning: string[] = [];
  const autoFixes: string[] = [];
  let grain: RecommendedGrain = "original_row";
  let aggregationRequired = false;
  let snapshotRequired = false;
  let confidence = 0.5;

  const isTemporal = TEMPORAL_OBJECTIVES.some(t => obj.includes(t));
  const isTransactional = TRANSACTIONAL_OBJECTIVES.some(t => obj.includes(t));
  const hasEntity = !!input.entityKey;
  const hasTime = !!input.timeColumn;
  const isMultiRow = input.dataShape === "multiple_rows_per_entity" ||
    (input.rowsPerEntity !== null && input.rowsPerEntity > 1.5);

  // Rule 1: Temporal objectives with entity + time → entity_time
  if (isTemporal && hasEntity && hasTime) {
    grain = "entity_time";
    // If data shape is unknown but temporal with entity+time, assume multi-row (safer default)
    const assumeMultiRow = isMultiRow || input.dataShape === "unknown";
    snapshotRequired = assumeMultiRow;
    aggregationRequired = assumeMultiRow;
    reasoning.push("Objetivo temporal com entidade e tempo válidos.");
    reasoning.push(isMultiRow ? "Dataset transacional → agregação necessária." : 
      input.dataShape === "unknown" ? "Shape desconhecido — agregação assumida por segurança." : 
      "Uma observação por entidade/período.");
    confidence = 0.9;
  }
  // Rule 2: Temporal objective, entity only (no time)
  else if (isTemporal && hasEntity && !hasTime) {
    grain = "entity_time";
    reasoning.push("Objetivo temporal detectado — grain entity_time assumido.");
    reasoning.push("⚠ Sem coluna temporal confirmada — confiança reduzida.");
    confidence = 0.6;
  }
  // Rule 3: Forecast → entity_product_time or entity_time
  else if (["demand_forecast", "revenue", "value_forecast"].some(o => obj.includes(o))) {
    grain = hasEntity ? "entity_product_time" : "entity_time";
    aggregationRequired = true;
    snapshotRequired = hasTime;
    reasoning.push("Forecast de valor/volume — requer grain temporal.");
    confidence = hasEntity && hasTime ? 0.85 : 0.6;
  }
  // Rule 4: Transactional (fraud, anomaly) → original_row or entity_event
  else if (isTransactional) {
    grain = hasEntity ? "entity_event" : "original_row";
    reasoning.push("Problema transacional — previsão por evento/linha.");
    confidence = 0.8;
  }
  // Rule 5: Multi-row per entity → aggregation
  else if (isMultiRow && hasEntity) {
    grain = hasTime ? "entity_time" : "entity";
    aggregationRequired = true;
    reasoning.push("Múltiplas linhas por entidade — agregação necessária.");
    confidence = 0.7;
  }
  // Rule 6: Single row per entity
  else if (input.dataShape === "one_row_per_entity") {
    grain = "original_row";
    reasoning.push("Uma linha por entidade — sem agregação.");
    confidence = 0.8;
  }
  // Default
  else {
    grain = "original_row";
    reasoning.push("Grain padrão: original_row.");
    confidence = 0.5;
  }

  // AUTO-FIX: grain incoherent with temporal objective
  if (isTemporal && grain === "original_row" && hasEntity) {
    grain = "entity_time";
    reasoning.push("Auto-fix: promovido de original_row para entity_time (objetivo temporal).");
    autoFixes.push("GRAIN_PROMOTED_TO_ENTITY_TIME");
    confidence = Math.max(confidence, 0.6);
  }

  return {
    recommended_grain: grain,
    entity_key: input.entityKey ? [input.entityKey] : [],
    time_key: input.timeColumn,
    grain_reasoning: reasoning,
    aggregation_required: aggregationRequired,
    snapshot_required: snapshotRequired,
    aggregation_plan: aggregationRequired ? {
      level: input.entityKey ? `${input.entityKey}_periodo` : "entity_periodo",
      method: "group_by_entity_time",
    } : null,
    confidence,
  };
}
