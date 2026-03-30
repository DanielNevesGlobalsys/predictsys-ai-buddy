// ═══════════════════════════════════════════════════════════════════
// Time Strategy Resolver — Deterministic Rules
// ═══════════════════════════════════════════════════════════════════

import type {
  TimeStrategy,
  SplitRecommendation,
  TemporalReadiness,
  TemporalColumnType,
  TemporalMode,
  SplitStrategy,
  RecommendedGrain,
} from "@/types/grainResolution";

// Date-like types from EDA inference
const DATE_TYPES = ["date", "datetime", "timestamp", "temporal", "data", "date/time"];

// Patterns that indicate post-event columns (NOT valid time anchors)
const POST_EVENT_PATTERNS = [
  "data_cancelamento", "cancellation_date", "data_obito", "death_date",
  "data_encerramento", "close_date", "data_saida", "exit_date",
  "termination_date", "data_fim", "end_date", "data_resultado",
];

// Patterns for snapshot/reference dates (preferred)
const SNAPSHOT_PATTERNS = [
  "data_ref", "dt_ref", "reference_date", "data_referencia",
  "snapshot_date", "data_base", "base_date", "periodo",
];

// Patterns for event dates
const EVENT_PATTERNS = [
  "data_compra", "order_date", "purchase_date", "data_pedido",
  "data_internacao", "admission_date", "data_evento", "event_date",
  "data_transacao", "transaction_date",
];

// Patterns for creation dates
const CREATION_PATTERNS = [
  "created_at", "data_criacao", "data_cadastro", "registration_date",
  "hire_date", "data_admissao", "data_contrato",
];

interface ColumnMeta {
  column_name: string;
  inferred_type: string;
  null_percent?: number;
  distinct_count?: number;
}

// ─── Classify temporal column type ─────────────────────────────

function classifyTemporalColumn(colName: string): TemporalColumnType {
  const lower = colName.toLowerCase();
  if (SNAPSHOT_PATTERNS.some(p => lower.includes(p))) return "snapshot_date";
  if (EVENT_PATTERNS.some(p => lower.includes(p))) return "event_date";
  if (CREATION_PATTERNS.some(p => lower.includes(p))) return "creation_date";
  return "unknown";
}

function isPostEventColumn(colName: string): boolean {
  return POST_EVENT_PATTERNS.some(p => colName.toLowerCase().includes(p));
}

function isDateType(inferredType: string): boolean {
  return DATE_TYPES.includes((inferredType || "").toLowerCase());
}

// Non-temporal values that look like dates but aren't
const FALSE_TEMPORAL_PATTERNS = [
  "flag", "is_", "status", "recompra", "boolean", "bin_",
];

function isFalseTemporalColumn(col: ColumnMeta): boolean {
  const lower = col.column_name.toLowerCase();
  if (FALSE_TEMPORAL_PATTERNS.some(p => lower.includes(p))) return true;
  // If distinct_count is very low (2-5) and type is not clearly date, it's probably categorical
  if ((col.distinct_count || 0) <= 5 && !isDateType(col.inferred_type)) return true;
  return false;
}

// ─── Resolve Time Strategy ─────────────────────────────────────

interface TimeInput {
  columns: ColumnMeta[];
  objective: string;
  existingTimeAnchor: string | null;
  grain: RecommendedGrain;
}

export function resolveTimeStrategy(input: TimeInput): TimeStrategy {
  const { columns, objective, existingTimeAnchor, grain } = input;
  const obj = (objective || "").toLowerCase();
  const reasoning: string[] = [];
  let fallbackApplied = false;

  // Determine if the problem requires time
  const TEMPORAL_OBJECTIVES = [
    "churn", "turnover", "no_show", "default_risk", "inadimplencia",
    "demand_forecast", "revenue", "value_forecast", "lifetime_value",
  ];
  const timeRequired = TEMPORAL_OBJECTIVES.some(t => obj.includes(t)) ||
    ["entity_time", "entity_product_time"].includes(grain);

  // Find all valid date columns
  const dateCols = columns.filter(c => isDateType(c.inferred_type) && !isFalseTemporalColumn(c));
  const safeDateCols = dateCols.filter(c => !isPostEventColumn(c.column_name));

  // AUTO-FIX 1: validate existing time anchor
  let timeColumn = existingTimeAnchor;
  let timeColumnType: TemporalColumnType = "unknown";
  let timeValid = false;

  if (timeColumn) {
    const col = columns.find(c => c.column_name === timeColumn);
    if (!col || !isDateType(col.inferred_type) || isFalseTemporalColumn(col)) {
      reasoning.push(`Auto-fix: "${timeColumn}" não é coluna temporal válida — removida.`);
      timeColumn = null;
      fallbackApplied = true;
    } else if (isPostEventColumn(timeColumn)) {
      reasoning.push(`Auto-fix: "${timeColumn}" é pós-evento — removida.`);
      timeColumn = null;
      fallbackApplied = true;
    } else {
      timeColumnType = classifyTemporalColumn(timeColumn);
      timeValid = true;
      reasoning.push(`Coluna temporal validada: ${timeColumn} (${timeColumnType}).`);
    }
  }

  // If no valid time column, try to find one
  if (!timeColumn && safeDateCols.length > 0) {
    // Priority: snapshot > event > creation > first available
    const snapshot = safeDateCols.find(c => classifyTemporalColumn(c.column_name) === "snapshot_date");
    const event = safeDateCols.find(c => classifyTemporalColumn(c.column_name) === "event_date");
    const creation = safeDateCols.find(c => classifyTemporalColumn(c.column_name) === "creation_date");
    const best = snapshot || event || creation || safeDateCols[0];

    timeColumn = best.column_name;
    timeColumnType = classifyTemporalColumn(timeColumn);
    timeValid = true;
    reasoning.push(`Coluna temporal inferida: ${timeColumn} (${timeColumnType}).`);
    if (existingTimeAnchor) fallbackApplied = true;
  }

  if (!timeColumn) {
    reasoning.push("Nenhuma coluna temporal válida encontrada.");
  }

  // Resolve temporal mode
  let temporalMode: TemporalMode = "atemporal";
  let windowDays: number | null = null;

  if (timeValid && timeColumn) {
    if (timeColumnType === "snapshot_date") {
      temporalMode = "snapshot_supervised";
      windowDays = 90;
      reasoning.push("Modo: snapshot supervisionado com janela de 90 dias.");
    } else if (timeColumnType === "event_date") {
      temporalMode = "event_supervised";
      windowDays = 30;
      reasoning.push("Modo: supervisão por evento.");
    } else {
      temporalMode = "time_series";
      windowDays = 60;
      reasoning.push("Modo: série temporal genérica.");
    }
  } else {
    temporalMode = "atemporal";
    if (timeRequired) {
      reasoning.push("⚠ Problema requer tempo mas nenhuma coluna válida foi encontrada.");
    } else {
      reasoning.push("Problema não requer temporalidade explícita.");
    }
  }

  const confidence = timeValid ? (timeColumnType !== "unknown" ? 0.9 : 0.7) :
    (timeRequired ? 0.3 : 0.6);

  return {
    time_column: timeColumn,
    time_column_type: timeColumn ? timeColumnType : "unknown",
    time_valid: timeValid,
    time_required: timeRequired,
    temporal_mode: temporalMode,
    window_days: windowDays,
    time_reasoning: reasoning,
    fallback_applied: fallbackApplied,
    confidence,
  };
}

// ─── Resolve Split Strategy ────────────────────────────────────

interface SplitInput {
  timeValid: boolean;
  timeRequired: boolean;
  grain: RecommendedGrain;
  entityKey: string | null;
  objective: string;
}

export function resolveSplitStrategy(input: SplitInput): SplitRecommendation {
  const { timeValid, timeRequired, grain, entityKey, objective } = input;
  const reasoning: string[] = [];
  let recommended: SplitStrategy = "random";
  let fallbackSplit: SplitStrategy | null = null;
  let fallbackReason: string | null = null;
  let confidence = 0.5;

  // Rule 1: Temporal split when time is valid and problem is temporal
  if (timeValid && timeRequired) {
    recommended = "temporal";
    reasoning.push("Split temporal recomendado — problema envolve evento futuro.");
    reasoning.push("Risco de vazamento com split aleatório.");
    confidence = 0.9;
    fallbackSplit = "stratified";
    fallbackReason = "Caso temporal falhe, usar estratificado.";
  }
  // Rule 2: Time valid but not strictly required
  else if (timeValid && !timeRequired) {
    recommended = "temporal";
    reasoning.push("Split temporal disponível e preferido para robustez.");
    confidence = 0.75;
    fallbackSplit = "stratified";
    fallbackReason = "Temporal preferido mas não obrigatório.";
  }
  // Rule 3: No time but has entity → grouped
  else if (!timeValid && entityKey && ["entity_time", "entity"].includes(grain)) {
    recommended = "grouped_by_entity";
    reasoning.push("Split agrupado por entidade — sem coluna temporal.");
    reasoning.push("Evita vazamento entre entidades.");
    confidence = 0.7;
    fallbackSplit = "stratified";
    fallbackReason = "Agrupado por entidade não viável.";
  }
  // Rule 4: No time, temporal required → stratified with warning
  else if (!timeValid && timeRequired) {
    recommended = "stratified";
    reasoning.push("⚠ Problema temporal mas sem tempo válido — fallback para estratificado.");
    confidence = 0.4;
    fallbackSplit = "random";
    fallbackReason = "Sem tempo válido — usando estratificado como compromisso.";
  }
  // Default: stratified
  else {
    recommended = "stratified";
    reasoning.push("Split estratificado padrão.");
    confidence = 0.6;
  }

  // AUTO-FIX 3: Split temporal recommended but time invalid
  if (recommended === "temporal" && !timeValid) {
    recommended = "stratified";
    reasoning.push("Auto-fix: split temporal rebaixado para estratificado (tempo inválido).");
    fallbackReason = "Tempo inválido impediu split temporal.";
    confidence = 0.4;
  }

  return {
    recommended_split: recommended,
    split_reasoning: reasoning,
    fallback_split: fallbackSplit,
    fallback_reason: fallbackReason,
    confidence,
  };
}

// ─── Temporal Readiness ────────────────────────────────────────

export function assessTemporalReadiness(
  timeValid: boolean,
  timeRequired: boolean,
  timeColumn: string | null,
  columns: ColumnMeta[],
): TemporalReadiness {
  const issues: string[] = [];

  if (!timeValid && timeRequired) {
    issues.push("Problema requer temporalidade mas nenhuma coluna válida foi encontrada.");
  }

  if (timeColumn) {
    const col = columns.find(c => c.column_name === timeColumn);
    if (col && (col.null_percent || 0) > 30) {
      issues.push(`Coluna temporal "${timeColumn}" tem ${col.null_percent}% de nulos.`);
    }
  }

  const status = timeValid ? (issues.length === 0 ? "ready" : "partial") : "unavailable";

  return {
    has_valid_time: timeValid,
    time_coverage_pct: null, // would need sample analysis
    time_range_days: null,
    issues,
    status,
  };
}
