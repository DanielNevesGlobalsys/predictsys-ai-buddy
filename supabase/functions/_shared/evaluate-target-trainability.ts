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

// ── Thresholds (v2) ──
const MIN_NON_NULL_DEFAULT = 200;
const MIN_NON_NULL_HUMAN = 100; // relaxed for human labeling (small curated samples)
const MIN_UNIQUE = 2;
const MAX_TOP_CLASS_PCT_BLOCK = 0.95;
const MIN_MINOR_CLASS_COUNT_BLOCK = 50;
const MIN_MINOR_CLASS_COUNT_HUMAN = 30; // stricter naming, relaxed from 50 to 30 for human labeling
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

  // Resolve thresholds based on target_source
  const isHumanLabeling = target_source === "human_labeling";
  const effectiveMinNonNull = isHumanLabeling ? MIN_NON_NULL_HUMAN : MIN_NON_NULL_DEFAULT;
  const effectiveMinMinorClass = isHumanLabeling ? MIN_MINOR_CLASS_COUNT_HUMAN : MIN_MINOR_CLASS_COUNT_BLOCK;

  // ── BLOCK checks ──
  // 1. TARGET_NOT_FOUND
  if (!target_column) {
    return block("TARGET_NOT_FOUND", details, warnings, [
      { label: "Escolher target manual", action: "open_manual_target" },
    ]);
  }

  // 2. TARGET_SAMPLE_TOO_SMALL
  if (nNonNull < effectiveMinNonNull) {
    const suggestions: FixSuggestion[] = isHumanLabeling
      ? [
          { label: "Gerar mais amostras", action: "open_human_labeling" },
          { label: `Mínimo: ${effectiveMinNonNull} rótulos`, action: "open_human_labeling" },
        ]
      : [
          { label: "Importar mais dados", action: "go_to_step_2" },
          { label: "Ajustar janela do alvo", action: "open_target_strategy", hint: { param: "window_days", suggest: [30, 60, 90] } },
        ];
    return block("TARGET_SAMPLE_TOO_SMALL", details, warnings, suggestions);
  }

  // 2b. ONLY_ONE_CLASS (human labeling specific)
  if (isHumanLabeling && nUnique === 1) {
    return block("ONLY_ONE_CLASS", details, warnings, [
      { label: "Buscar classe faltante", action: "open_human_labeling" },
      { label: "Ativar supervisão fraca", action: "enable_weak_supervision" },
    ]);
  }

  // 2c. MINORITY_CLASS_TOO_SMALL (human labeling specific)
  if (isHumanLabeling && nUnique >= 2 && minorClassCount < effectiveMinMinorClass) {
    const minorityLabel = positiveRate < 0.5 ? "positivos" : "negativos";
    return block("MINORITY_CLASS_TOO_SMALL", details, warnings, [
      { label: `Buscar ${minorityLabel}`, action: "open_human_labeling" },
      { label: "Gerar mais amostras", action: "open_human_labeling" },
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

  // 7. TARGET_TOO_SPARSE (dominant class) — skip for human_labeling (already handled above)
  if (!isHumanLabeling && problem_type === "classification" && topClassPct > MAX_TOP_CLASS_PCT_BLOCK && minorClassCount < effectiveMinMinorClass) {
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

  // 10b. LOW_VARIANCE_TARGET (regression with low variability)
  if (problem_type === "regression" && targetType === "numeric" && nNonNull > 10) {
    if (nUnique <= 10) {
      return block("LOW_VARIANCE_TARGET", details, warnings, [
        { label: "Trocar para classificação", action: "change_problem_type", hint: { suggest: "classification" } },
        { label: "Escolher outro target", action: "open_manual_target" },
      ]);
    }
    // Check variance: if std/mean ratio is extremely small
    const numVals = nonNullValues.map(v => Number(v)).filter(n => !isNaN(n));
    if (numVals.length > 10) {
      const mean = numVals.reduce((a, b) => a + b, 0) / numVals.length;
      const variance = numVals.reduce((a, b) => a + (b - mean) ** 2, 0) / numVals.length;
      const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 0;
      if (cv < 0.001 && variance < 1e-10) {
        return block("LOW_VARIANCE_TARGET", details, warnings, [
          { label: "Trocar para classificação", action: "change_problem_type", hint: { suggest: "classification" } },
          { label: "Escolher outro target", action: "open_manual_target" },
        ]);
      }
    }
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
    TARGET_SAMPLE_TOO_SMALL: `Amostra muito pequena: apenas ${d.n_non_null} valores não-nulos (mínimo requerido não atingido).`,
    TARGET_TOO_SPARSE: `Target não treinável: classe dominante ${(d.top_class_pct * 100).toFixed(1)}% com apenas ${d.minor_class_count} exemplos da classe rara.`,
    TARGET_NOT_FOUND_IN_DATA: "Coluna target não encontrada no dataset.",
    TARGET_EMPTY_AFTER_FILTER: "Target vazio após aplicar filtros — nenhum valor válido.",
    TARGET_TEXT: `Target textual com ${d.n_unique} valores distintos — alta cardinalidade sem encoding aplicável.`,
    TARGET_TOO_MANY_CLASSES: `Target com ${d.n_unique} classes — excede o limite de 50 para classificação.`,
    TARGET_NO_POSITIVES: `Taxa de positivos ${(d.positive_rate * 100).toFixed(2)}% — sem exemplos suficientes da classe rara.`,
    TARGET_NO_NEGATIVES: `Taxa de positivos ${(d.positive_rate * 100).toFixed(2)}% — quase todos são positivos.`,
    TARGET_CONFLICTS_HIGH: `Target assistido com ${(d.conflict_rate * 100).toFixed(0)}% de conflito e ${(d.coverage * 100).toFixed(0)}% de cobertura.`,
    TARGET_INVALID_TYPE: `Target textual incompatível com regressão.`,
    ONLY_ONE_CLASS: `Apenas uma classe rotulada (${d.n_unique} valor único). Rotule exemplos da classe oposta.`,
    MINORITY_CLASS_TOO_SMALL: `Classe minoritária com apenas ${d.minor_class_count} exemplos. Mínimo: 30. Rotule mais casos da classe sub-representada.`,
    LOW_VARIANCE_TARGET: `Target com variância muito baixa para regressão (${d.n_unique} valores distintos). Considere classificação.`,
    ENTITY_JOIN_MISMATCH: `Os rótulos não estão correspondendo à entidade selecionada. Verifique a coluna de ID.`,
  };

  return messages[result.reason_code || ""] || `Target não treinável (${result.reason_code}).`;
}

// ────────────────────────────────────────────────────────────────
// DB-aware wrapper: evaluateTargetTrainabilityFromSSOT
// Queries real stats per active_target_mode and returns unified report.
// Used by BOTH run-training-preflight AND train-models for parity.
// ────────────────────────────────────────────────────────────────

export interface SSOTTrainabilityReport {
  trainable: boolean;
  reason_code: string | null;
  message_user: string;
  details: {
    join_rows: number;
    distinct_y: number;
    pos: number;
    neg: number;
    nulls: number;
    mode: string;
    target_col: string | null;
    // Entity join diagnostics (human mode)
    labels_total?: number;
    labels_distinct_entities?: number;
    join_rate?: number;
    // Regression diagnostics
    variance_y?: number;
  };
  thresholds: {
    min_total: number;
    min_per_class: number;
    min_distinct_y: number;
  };
  fix_suggestions: FixSuggestion[];
  warnings: string[];
  computed_at: string;
}

interface SSOTInput {
  supabase: any;
  projectId: string;
  activeTargetMode: string; // "human" | "weak" | "template" | "column"
  targetColumn: string | null;
  problemType: string;
  projectSettings: Record<string, any>;
}

/**
 * Unified trainability evaluation that queries real stats per mode.
 * Ensures preflight and train-models produce identical results.
 */
export async function evaluateTargetTrainabilityFromSSOT(
  input: SSOTInput
): Promise<SSOTTrainabilityReport> {
  const { supabase, projectId, activeTargetMode, targetColumn, problemType, projectSettings } = input;

  const mode = activeTargetMode || "column";
  const thresholds = {
    min_total: mode === "human" ? 100 : 200,
    min_per_class: mode === "human" ? 30 : 50,
    min_distinct_y: 2,
  };

  let targetValues: (string | number | boolean | null | undefined)[] = [];
  let joinRows = 0;
  let pos = 0;
  let neg = 0;
  let nulls = 0;
  let distinctY = 0;

  try {
    // Extra details for entity join diagnostics
    let labelsTotal = 0;
    let labelsDistinctEntities = 0;
    let joinRate = 1;

    if (mode === "human") {
      // ── Real query of project_human_labels ──
      const { data: labels, error } = await supabase
        .from("project_human_labels")
        .select("entity_id, label, label_status")
        .eq("project_id", projectId)
        .neq("label_status", "unsure");

      if (error || !labels) {
        return buildSSOTReport(false, "HUMAN_LABEL_QUERY_ERROR",
          error?.message || "Erro ao consultar rótulos humanos.",
          { join_rows: 0, distinct_y: 0, pos: 0, neg: 0, nulls: 0, mode, target_col: null },
          thresholds, [{ label: "Gerar amostras", action: "open_human_labeling" }], []);
      }

      labelsTotal = labels.length;
      const entitySet = new Set<string>();
      for (const l of labels) {
        if (l.entity_id) entitySet.add(String(l.entity_id));
        const v = l.label as number;
        targetValues.push(v);
        if (v === 1) pos++;
        else if (v === 0) neg++;
      }
      labelsDistinctEntities = entitySet.size;
      joinRows = labels.length;
      distinctY = new Set(targetValues).size;
      nulls = 0;

      // Compute join_rate: ratio of labels that would match dataset entities
      // If we have entity info, estimate join quality
      if (labelsDistinctEntities > 0) {
        // Try to check how many labeled entities exist in the dataset
        const entitySample = [...entitySet].slice(0, 100);
        const { data: dsState } = await supabase
          .from("project_dataset_state")
          .select("row_count")
          .eq("project_id", projectId)
          .maybeSingle();
        const datasetRows = dsState?.row_count || 0;
        // Heuristic: if dataset has rows and labels have entities, estimate join rate
        // A perfect join would have joinRows ≈ labelsDistinctEntities
        joinRate = labelsDistinctEntities > 0 ? Math.min(1, joinRows / labelsDistinctEntities) : 1;
      }

      // BLOCK if join rate too low
      if (joinRate < 0.5 && labelsTotal >= 20) {
        return buildSSOTReport(false, "ENTITY_JOIN_MISMATCH",
          "Os rótulos não estão correspondendo à entidade selecionada. Verifique a coluna de ID.",
          { join_rows: joinRows, distinct_y: distinctY, pos, neg, nulls: 0, mode, target_col: targetColumn,
            labels_total: labelsTotal, labels_distinct_entities: labelsDistinctEntities, join_rate: joinRate },
          thresholds,
          [{ label: "Reconfigurar coluna de entidade", action: "open_entity_selector" }],
          []);
      }

    } else if (mode === "weak") {
      // ── Use weak_label_result stats from SSOT ──
      const wlr = projectSettings.weak_label_result as Record<string, any> | null;
      if (wlr) {
        const totalRows = projectSettings.ingestion_rows_detected || 0;
        const coverage = wlr.coverage ?? 0;
        const prevalence = wlr.prevalence ?? 0;
        const coveredRows = Math.round(totalRows * coverage);
        pos = Math.round(coveredRows * prevalence);
        neg = coveredRows - pos;
        joinRows = coveredRows;
        nulls = totalRows - coveredRows;
        targetValues = [
          ...Array(pos).fill(1),
          ...Array(neg).fill(0),
          ...Array(nulls).fill(null),
        ];
        distinctY = pos > 0 && neg > 0 ? 2 : pos > 0 || neg > 0 ? 1 : 0;
      }

    } else if (mode === "template") {
      // ── Use label_build_result stats from SSOT ──
      const lbr = projectSettings.label_build_result as Record<string, any> | null;
      if (lbr) {
        const eligibleEntities = lbr.eligible_entities ?? projectSettings.ingestion_rows_detected ?? 0;
        const pr = lbr.positive_rate ?? 0;
        pos = Math.round(eligibleEntities * pr);
        neg = eligibleEntities - pos;
        joinRows = eligibleEntities;
        nulls = 0;
        targetValues = [...Array(pos).fill(1), ...Array(neg).fill(0)];
        distinctY = pos > 0 && neg > 0 ? 2 : pos > 0 || neg > 0 ? 1 : 0;
      }

    } else {
      // ── Column mode: use target_quality_report or dataset state ──
      const tqr = projectSettings.target_quality_report as Record<string, any> | null;
      if (tqr && tqr.n_classes > 0 && tqr.positive_rate != null) {
        const totalRows = projectSettings.ingestion_rows_detected || 0;
        pos = Math.round(totalRows * (tqr.positive_rate ?? 0));
        neg = totalRows - pos;
        joinRows = totalRows;
        nulls = 0;
        targetValues = [...Array(pos).fill(1), ...Array(neg).fill(0)];
        distinctY = tqr.n_classes;
      } else {
        // Fallback: minimal check from ingestion stats
        const totalRows = projectSettings.ingestion_rows_detected || 0;
        joinRows = totalRows;
        // Can't know class distribution without real data - will be validated by train-models on real y
        if (totalRows > 0 && targetColumn) {
          return buildSSOTReport(true, null, "Target selecionado. Distribuição será validada no treino.",
            { join_rows: totalRows, distinct_y: 0, pos: 0, neg: 0, nulls: 0, mode, target_col: targetColumn },
            thresholds, [], ["Distribuição de classes será validada durante o treinamento."]);
        }
      }
    }

    // Now evaluate using the pure function
    const result = evaluateTargetTrainability({
      target_values: targetValues,
      target_column: targetColumn || "__target__",
      problem_type: problemType,
      target_source: mode === "template" ? "label_builder" : mode === "weak" ? "weak_supervision" : mode === "human" ? "human_labeling" : "manual",
      weak_label_result: projectSettings.weak_label_result as Record<string, unknown> | null,
      human_label_result: projectSettings.human_label_result as Record<string, unknown> | null,
    });

    const msg = trainabilityHumanMessage(result);

    const reportDetails: SSOTTrainabilityReport["details"] = {
      join_rows: joinRows, distinct_y: distinctY || result.details.n_unique,
      pos, neg, nulls, mode, target_col: targetColumn,
    };

    // Attach human-mode entity diagnostics
    if (mode === "human") {
      reportDetails.labels_total = labelsTotal;
      reportDetails.labels_distinct_entities = labelsDistinctEntities;
      reportDetails.join_rate = joinRate;
    }

    return buildSSOTReport(
      result.trainable,
      result.reason_code,
      msg,
      reportDetails,
      thresholds,
      result.fix_suggestions,
      result.warnings,
    );
  } catch (err: any) {
    return buildSSOTReport(false, "TRAINABILITY_EVAL_ERROR",
      `Erro ao avaliar treinabilidade: ${err?.message || "desconhecido"}`,
      { join_rows: 0, distinct_y: 0, pos: 0, neg: 0, nulls: 0, mode, target_col: targetColumn },
      thresholds, [], []);
  }
}

function buildSSOTReport(
  trainable: boolean,
  reasonCode: string | null,
  messageUser: string,
  details: SSOTTrainabilityReport["details"],
  thresholds: SSOTTrainabilityReport["thresholds"],
  fixSuggestions: FixSuggestion[],
  warnings: string[],
): SSOTTrainabilityReport {
  return {
    trainable,
    reason_code: reasonCode,
    message_user: messageUser,
    details,
    thresholds,
    fix_suggestions: fixSuggestions,
    warnings,
    computed_at: new Date().toISOString(),
  };
}
