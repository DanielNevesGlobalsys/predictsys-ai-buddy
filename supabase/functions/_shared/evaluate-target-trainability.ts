/**
 * evaluateTargetTrainability — Canonical diagnostic for target trainability.
 * Shared between run-training-preflight and train-models.
 */

export interface TrainabilityDetails {
  n_rows: number;
  n_non_null: number;
  n_unique: number;
  positive_rate: number;
  top_class_pct: number;
  minor_class_count: number;
  conflict_rate: number;
  coverage: number;
  target_type?: string;
}

export interface FixSuggestion {
  label: string;
  action: string;
  hint?: Record<string, unknown>;
}

export interface TrainabilityResult {
  trainable: boolean;
  reason_code: string | null;
  details: TrainabilityDetails;
  fix_suggestions: FixSuggestion[];
  warnings: string[];
}

interface TrainabilityInput {
  target_values: (string | number | boolean | null | undefined)[];
  target_column: string;
  problem_type: string;
  target_source: string; // manual | label_builder | weak_supervision | human_labeling
  weak_label_result?: Record<string, unknown> | null;
  human_label_result?: Record<string, unknown> | null;
}

// ── Thresholds (v1) ──
const MIN_NON_NULL = 200;
const MIN_UNIQUE = 2;
const MAX_TOP_CLASS_PCT_BLOCK = 0.95;
const MIN_MINOR_CLASS_COUNT_BLOCK = 50;
const MIN_POSITIVE_RATE = 0.005;
const MAX_POSITIVE_RATE = 0.995;
const MAX_CONFLICT_RATE_BLOCK = 0.60;
const MIN_COVERAGE_BLOCK = 0.20;
const MAX_TOP_CLASS_PCT_WARN = 0.90;
const MIN_COVERAGE_WARN = 0.40;
const MAX_TEXT_CARDINALITY = 100;

/**
 * Evaluate whether the target column is trainable.
 * Pure function — does not make DB calls.
 */
export function evaluateTargetTrainability(input: TrainabilityInput): TrainabilityResult {
  const { target_values, target_column, problem_type, target_source, weak_label_result, human_label_result } = input;

  const warnings: string[] = [];
  const nRows = target_values.length;
  const nonNullValues = target_values.filter(v => v !== null && v !== undefined && v !== "" && v !== "null");
  const nNonNull = nonNullValues.length;

  // Count unique values
  const valueCounts = new Map<string, number>();
  for (const v of nonNullValues) {
    const key = String(v);
    valueCounts.set(key, (valueCounts.get(key) || 0) + 1);
  }
  const nUnique = valueCounts.size;

  // Sorted by frequency desc
  const sorted = [...valueCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topClassCount = sorted.length > 0 ? sorted[0][1] : 0;
  const topClassPct = nNonNull > 0 ? topClassCount / nNonNull : 0;
  const minorClassCount = sorted.length > 1 ? sorted[sorted.length - 1][1] : 0;

  // Positive rate (binary classification heuristic: smallest class)
  let positiveRate = 0;
  if (nUnique === 2 && nNonNull > 0) {
    positiveRate = minorClassCount / nNonNull;
  } else if (nUnique > 2 && nNonNull > 0) {
    positiveRate = minorClassCount / nNonNull;
  }

  // Weak supervision metrics
  const conflictRate = Number((weak_label_result as any)?.conflict_rate ?? 0);
  const coverage = Number((weak_label_result as any)?.coverage ?? (nNonNull / Math.max(nRows, 1)));

  // Detect target type
  const sampleNonNull = nonNullValues.slice(0, 100);
  const allNumeric = sampleNonNull.every(v => !isNaN(Number(v)));
  const allText = sampleNonNull.every(v => typeof v === "string" && isNaN(Number(v)));
  const targetType = allNumeric ? "numeric" : allText ? "text" : "mixed";

  const details: TrainabilityDetails = {
    n_rows: nRows,
    n_non_null: nNonNull,
    n_unique: nUnique,
    positive_rate: positiveRate,
    top_class_pct: topClassPct,
    minor_class_count: minorClassCount,
    conflict_rate: conflictRate,
    coverage,
    target_type: targetType,
  };

  // ── BLOCK checks ──
  // 1. TARGET_NOT_FOUND
  if (!target_column) {
    return block("TARGET_NOT_FOUND", details, warnings, [
      { label: "Escolher target manual", action: "open_manual_target" },
    ]);
  }

  // 2. TARGET_SAMPLE_TOO_SMALL
  if (nNonNull < MIN_NON_NULL) {
    return block("TARGET_SAMPLE_TOO_SMALL", details, warnings, [
      { label: "Importar mais dados", action: "go_to_step_2" },
      { label: "Ajustar janela do alvo", action: "open_target_strategy", hint: { param: "window_days", suggest: [30, 60, 90] } },
    ]);
  }

  // 3. TARGET_CONSTANT / SINGLE_CLASS
  if (nUnique < MIN_UNIQUE) {
    const code = nUnique === 1 ? "TARGET_CONSTANT" : "TARGET_SINGLE_CLASS";
    return block(code, details, warnings, [
      { label: "Ajustar janela do alvo", action: "open_target_strategy", hint: { param: "window_days", suggest: [30, 60, 90] } },
      { label: "Ativar modo assistido", action: "enable_weak_supervision" },
      { label: "Escolher target manual", action: "open_manual_target" },
    ]);
  }

  // 4. TARGET_EMPTY_AFTER_FILTER
  if (nNonNull === 0) {
    return block("TARGET_EMPTY_AFTER_FILTER", details, warnings, [
      { label: "Revisar entity_key e time_anchor", action: "open_target_strategy" },
      { label: "Escolher target manual", action: "open_manual_target" },
    ]);
  }

  // 5. TARGET_TEXT with high cardinality
  if (targetType === "text" && nUnique > MAX_TEXT_CARDINALITY && problem_type === "classification") {
    return block("TARGET_TEXT", details, warnings, [
      { label: "Binarizar ou agrupar classes", action: "open_target_strategy" },
      { label: "Trocar para regressão", action: "change_problem_type", hint: { suggest: "regression" } },
    ]);
  }

  // 6. TARGET_TOO_MANY_CLASSES
  if (problem_type === "classification" && nUnique > 50) {
    return block("TARGET_TOO_MANY_CLASSES", details, warnings, [
      { label: "Binarizar ou agrupar classes", action: "open_target_strategy" },
      { label: "Trocar para regressão", action: "change_problem_type", hint: { suggest: "regression" } },
    ]);
  }

  // 7. TARGET_TOO_SPARSE (dominant class)
  if (problem_type === "classification" && topClassPct > MAX_TOP_CLASS_PCT_BLOCK && minorClassCount < MIN_MINOR_CLASS_COUNT_BLOCK) {
    return block("TARGET_TOO_SPARSE", details, warnings, [
      { label: "Ajustar janela do alvo", action: "open_target_strategy", hint: { param: "window_days", suggest: [30, 60, 90] } },
      { label: "Usar proxy 'queda de atividade'", action: "open_target_strategy" },
      { label: "Ativar modo assistido", action: "enable_weak_supervision" },
    ]);
  }

  // 8. TARGET_NO_POSITIVES / TARGET_NO_NEGATIVES
  if (problem_type === "classification" && nUnique === 2) {
    if (positiveRate < MIN_POSITIVE_RATE) {
      return block("TARGET_NO_POSITIVES", details, warnings, [
        { label: "Ajustar janela do alvo", action: "open_target_strategy", hint: { param: "window_days", suggest: [30, 60, 90] } },
        { label: "Ativar modo assistido", action: "enable_weak_supervision" },
        { label: "Rotulagem rápida (50-200)", action: "open_human_labeling" },
      ]);
    }
    if (positiveRate > MAX_POSITIVE_RATE) {
      return block("TARGET_NO_NEGATIVES", details, warnings, [
        { label: "Ajustar janela do alvo", action: "open_target_strategy", hint: { param: "window_days", suggest: [30, 60, 90] } },
        { label: "Escolher target manual", action: "open_manual_target" },
      ]);
    }
  }

  // 9. TARGET_CONFLICTS_HIGH (weak supervision)
  if (target_source === "weak_supervision" && conflictRate > MAX_CONFLICT_RATE_BLOCK && coverage < MIN_COVERAGE_BLOCK) {
    return block("TARGET_CONFLICTS_HIGH", details, warnings, [
      { label: "Reduzir regras conflitantes", action: "open_weak_supervision_config" },
      { label: "Aumentar threshold de confiança", action: "open_weak_supervision_config" },
      { label: "Rotulagem rápida (50-200)", action: "open_human_labeling" },
    ]);
  }

  // 10. TARGET_INVALID_TYPE (regression on text)
  if (problem_type === "regression" && targetType === "text") {
    return block("TARGET_INVALID_TYPE", details, warnings, [
      { label: "Trocar para classificação", action: "change_problem_type", hint: { suggest: "classification" } },
      { label: "Escolher target numérico", action: "open_manual_target" },
    ]);
  }

  // ── WARN checks ──
  if (problem_type === "classification" && topClassPct > MAX_TOP_CLASS_PCT_WARN) {
    warnings.push(`Classe dominante com ${(topClassPct * 100).toFixed(1)}% — class_weight será aplicado automaticamente.`);
  }

  if (target_source === "weak_supervision" && coverage < MIN_COVERAGE_WARN) {
    warnings.push(`Cobertura do target assistido em ${(coverage * 100).toFixed(0)}% — resultados podem ser limitados.`);
  }

  return {
    trainable: true,
    reason_code: null,
    details,
    fix_suggestions: [],
    warnings,
  };
}

function block(
  reasonCode: string,
  details: TrainabilityDetails,
  warnings: string[],
  fixSuggestions: FixSuggestion[],
): TrainabilityResult {
  return {
    trainable: false,
    reason_code: reasonCode,
    details,
    fix_suggestions: fixSuggestions,
    warnings,
  };
}

/**
 * Build a short human-readable message for the given reason_code.
 */
export function trainabilityHumanMessage(result: TrainabilityResult): string {
  if (result.trainable) return "Target treinável.";

  const d = result.details;
  const messages: Record<string, string> = {
    TARGET_NOT_FOUND: "Nenhum target selecionado.",
    TARGET_CONSTANT: `Target constante (apenas 1 valor único em ${d.n_non_null} registros).`,
    TARGET_SINGLE_CLASS: `Target com apenas ${d.n_unique} valor(es) único(s).`,
    TARGET_SAMPLE_TOO_SMALL: `Amostra muito pequena: apenas ${d.n_non_null} valores não-nulos (mínimo: ${MIN_NON_NULL}).`,
    TARGET_TOO_SPARSE: `Target não treinável: classe dominante ${(d.top_class_pct * 100).toFixed(1)}% com apenas ${d.minor_class_count} exemplos da classe rara (mínimo: ${MIN_MINOR_CLASS_COUNT_BLOCK}).`,
    TARGET_NOT_FOUND_IN_DATA: "Coluna target não encontrada no dataset.",
    TARGET_EMPTY_AFTER_FILTER: "Target vazio após aplicar filtros — nenhum valor válido.",
    TARGET_TEXT: `Target textual com ${d.n_unique} valores distintos — alta cardinalidade sem encoding aplicável.`,
    TARGET_TOO_MANY_CLASSES: `Target com ${d.n_unique} classes — excede o limite de 50 para classificação.`,
    TARGET_NO_POSITIVES: `Taxa de positivos ${(d.positive_rate * 100).toFixed(2)}% — sem exemplos suficientes da classe rara.`,
    TARGET_NO_NEGATIVES: `Taxa de positivos ${(d.positive_rate * 100).toFixed(2)}% — quase todos são positivos.`,
    TARGET_CONFLICTS_HIGH: `Target assistido com ${(d.conflict_rate * 100).toFixed(0)}% de conflito e ${(d.coverage * 100).toFixed(0)}% de cobertura.`,
    TARGET_INVALID_TYPE: `Target textual incompatível com regressão.`,
  };

  return messages[result.reason_code || ""] || `Target não treinável (${result.reason_code}).`;
}
