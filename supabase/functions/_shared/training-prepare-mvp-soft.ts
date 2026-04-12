/**
 * training-prepare-mvp-soft.ts
 * 
 * MVP-Soft preparation utilities for the training pipeline.
 * Handles target type detection, type coercion, categorical encoding,
 * row sampling, and missing value imputation BEFORE model fitting.
 * 
 * Does NOT alter algorithms, split logic, or scoring.
 */

// ── Types ──

export interface MVPSoftResult {
  status: "ready" | "blocked";
  code?: string;
  message_user?: string;
  fix_suggestions?: { label: string; action: string; hint?: Record<string, unknown> }[];
  warnings: string[];
  meta: {
    original_rows: number;
    used_rows: number;
    sampled: boolean;
    sample_strategy: string;
    n_features_before: number;
    n_features_after: number;
    target_type_real: string;
    coercions_applied: string[];
    missing_strategy: Record<string, string>;
    encoding_applied: string[];
  };
}

export interface TargetTypeDetection {
  type: "numeric_continuous" | "numeric_discrete" | "categorical" | "boolean" | "mixed";
  distinct_count: number;
  sample_size: number;
  all_integer: boolean;
  has_strings: boolean;
}

// ── Constants ──

const TRAINING_ROW_CAP = 200_000;
const HIGH_CARDINALITY_THRESHOLD = 50;
const ONE_HOT_TOP_K = 20;

// ── Target Type Detection ──

export function detectTargetType(
  yRaw: (string | number | boolean | null | undefined)[],
): TargetTypeDetection {
  const nonNull = yRaw.filter(v => v !== null && v !== undefined && v !== "" && String(v) !== "null");
  if (nonNull.length === 0) {
    return { type: "mixed", distinct_count: 0, sample_size: 0, all_integer: false, has_strings: false };
  }

  const sample = nonNull.slice(0, 5000);
  const distinct = new Set(sample.map(v => String(v).trim().toLowerCase()));
  const distinctCount = distinct.size;

  // Check for boolean patterns
  const boolValues = new Set(["true", "false", "0", "1", "yes", "no", "sim", "não", "nao"]);
  const allBool = [...distinct].every(v => boolValues.has(v));
  if (allBool && distinctCount <= 4) {
    return { type: "boolean", distinct_count: distinctCount, sample_size: sample.length, all_integer: false, has_strings: false };
  }

  // Check numeric
  let numericCount = 0;
  let integerCount = 0;
  let stringCount = 0;

  for (const v of sample) {
    const s = String(v).trim().replace(",", ".");
    const n = Number(s);
    if (!isNaN(n) && s !== "") {
      numericCount++;
      if (Number.isInteger(n)) integerCount++;
    } else {
      stringCount++;
    }
  }

  const numericRatio = numericCount / sample.length;
  const allInteger = integerCount === numericCount && numericCount > 0;
  const hasStrings = stringCount > 0;

  if (numericRatio > 0.9 && !hasStrings) {
    if (allInteger && distinctCount <= 20) {
      return { type: "numeric_discrete", distinct_count: distinctCount, sample_size: sample.length, all_integer: true, has_strings: false };
    }
    return { type: "numeric_continuous", distinct_count: distinctCount, sample_size: sample.length, all_integer: allInteger, has_strings: false };
  }

  if (hasStrings || numericRatio < 0.5) {
    return { type: "categorical", distinct_count: distinctCount, sample_size: sample.length, all_integer: false, has_strings: true };
  }

  return { type: "mixed", distinct_count: distinctCount, sample_size: sample.length, all_integer: allInteger, has_strings: hasStrings };
}

// ── Target Type Mismatch Validation ──

export function validateTargetTypeMismatch(
  problemType: string,
  targetDetection: TargetTypeDetection,
): { valid: boolean; code?: string; message?: string; suggestion?: string } {
  // Regression on categorical/boolean/discrete target
  if (problemType === "regression") {
    if (targetDetection.type === "categorical" || targetDetection.type === "boolean") {
      return {
        valid: false,
        code: "TARGET_TYPE_MISMATCH",
        message: `Seu target parece ${targetDetection.type === "boolean" ? "booleano" : "categórico"} (${targetDetection.distinct_count} valores distintos). Troque para Classificação.`,
        suggestion: "classification",
      };
    }
    if (targetDetection.type === "numeric_discrete" && targetDetection.distinct_count <= 10) {
      return {
        valid: false,
        code: "TARGET_TYPE_MISMATCH",
        message: `Seu target tem apenas ${targetDetection.distinct_count} valores inteiros distintos — parece categórico. Troque para Classificação.`,
        suggestion: "classification",
      };
    }
  }

  // Classification on continuous numeric target with many unique values
  if (problemType === "classification") {
    if (targetDetection.type === "numeric_continuous" && targetDetection.distinct_count > HIGH_CARDINALITY_THRESHOLD) {
      return {
        valid: false,
        code: "TARGET_TYPE_MISMATCH",
        message: `Seu target tem ${targetDetection.distinct_count} valores numéricos únicos — parece contínuo. Troque para Regressão.`,
        suggestion: "regression",
      };
    }
  }

  return { valid: true };
}

// ── Robust Numeric Coercion ──

export function coerceToNumber(value: any): number {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;

  let s = String(value).trim();

  // Boolean string coercion
  const lower = s.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "sim") return 1;
  if (lower === "false" || lower === "no" || lower === "não" || lower === "nao") return 0;

  // Handle "1.234,56" → "1234.56" (Brazilian/European format)
  if (s.includes(",") && s.includes(".")) {
    // If comma comes after dot: "1.234,56" → European
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    }
    // else: "1,234.56" → US format, just remove commas
    else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",") && !s.includes(".")) {
    // Single comma: could be decimal separator
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 3) {
      s = s.replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  }

  // Remove currency symbols and whitespace
  s = s.replace(/[R$€£¥\s%]/g, "");

  const n = Number(s);
  return isNaN(n) ? NaN : n;
}

// ── Categorical Encoding (Top-K one-hot + "other") ──

export interface EncodingMap {
  column: string;
  method: "one_hot_topk" | "ordinal";
  categories: string[];
  top_k: number;
}

export function buildEncodingMap(
  values: string[],
  columnName: string,
): EncodingMap {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = String(v ?? "missing").trim() || "missing";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const topK = sorted.slice(0, ONE_HOT_TOP_K).map(([k]) => k);

  return {
    column: columnName,
    method: "one_hot_topk",
    categories: topK,
    top_k: ONE_HOT_TOP_K,
  };
}

export function applyOneHotEncoding(
  value: string | null | undefined,
  encoding: EncodingMap,
): number[] {
  const v = String(value ?? "missing").trim() || "missing";
  const result = new Array(encoding.categories.length).fill(0);
  const idx = encoding.categories.indexOf(v);
  if (idx !== -1) {
    result[idx] = 1;
  }
  // If not in top-K, all zeros (represents "other")
  return result;
}

// ── Missing Value Imputation ──

export function imputeMissing(
  values: number[],
  strategy: "median" | "mean" | "zero" = "median",
): { imputed: number[]; fill_value: number } {
  const valid = values.filter(v => !isNaN(v) && isFinite(v));
  let fillValue: number;

  if (valid.length === 0) {
    fillValue = 0;
  } else if (strategy === "median") {
    const sorted = [...valid].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    fillValue = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  } else if (strategy === "mean") {
    fillValue = valid.reduce((a, b) => a + b, 0) / valid.length;
  } else {
    fillValue = 0;
  }

  return {
    imputed: values.map(v => (isNaN(v) || !isFinite(v)) ? fillValue : v),
    fill_value: fillValue,
  };
}

// ── Date Feature Extraction ──

export function isDateValue(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return !isNaN(value.getTime());
  const s = String(value).trim();
  if (s.length < 6 || s.length > 30) return false;
  const d = new Date(s);
  return !isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2100;
}

export function extractDateFeatures(value: any): Record<string, number> {
  const d = value instanceof Date ? value : new Date(String(value));
  if (isNaN(d.getTime())) return {};
  return {
    _year: d.getFullYear(),
    _month: d.getMonth() + 1,
    _day_of_week: d.getDay(),
    _day_of_month: d.getDate(),
  };
}

// ── Row Sampling ──

export function sampleRows<T>(
  rows: T[],
  cap: number,
  yValues: number[],
  problemType: string,
): { sampled: T[]; sampledY: number[]; strategy: string } {
  if (rows.length <= cap) {
    return { sampled: rows, sampledY: yValues, strategy: "full" };
  }

  if (problemType === "classification") {
    // Stratified sampling by class
    const buckets = new Map<number, number[]>();
    yValues.forEach((y, i) => {
      if (!buckets.has(y)) buckets.set(y, []);
      buckets.get(y)!.push(i);
    });

    const perClass = Math.floor(cap / buckets.size);
    const indices: number[] = [];

    buckets.forEach((classIndices) => {
      const shuffled = shuffleArray(classIndices);
      indices.push(...shuffled.slice(0, Math.max(perClass, Math.min(classIndices.length, 50))));
    });

    // Shuffle and trim to cap
    const finalIndices = shuffleArray(indices).slice(0, cap);
    return {
      sampled: finalIndices.map(i => rows[i]),
      sampledY: finalIndices.map(i => yValues[i]),
      strategy: "stratified_class",
    };
  } else {
    // Random sampling for regression
    const indices = shuffleArray(Array.from({ length: rows.length }, (_, i) => i)).slice(0, cap);
    return {
      sampled: indices.map(i => rows[i]),
      sampledY: indices.map(i => yValues[i]),
      strategy: "random",
    };
  }
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Compute Target Stats ──

export interface TargetStats {
  n_total: number;
  n_valid: number;
  n_null: number;
  n_unique: number;
  target_type_real: string;
  variance: number;
  std: number;
  mean: number;
  class_distribution: Record<string, number>;
}

export function computeTargetStats(yValues: number[], isClassification: boolean): TargetStats {
  const valid = yValues.filter(v => !isNaN(v) && isFinite(v));
  const n = valid.length;
  const mean = n > 0 ? valid.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 0 ? valid.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  const unique = new Set(valid);

  const classDist: Record<string, number> = {};
  if (isClassification) {
    for (const v of valid) {
      const key = String(v);
      classDist[key] = (classDist[key] || 0) + 1;
    }
  }

  return {
    n_total: yValues.length,
    n_valid: n,
    n_null: yValues.length - n,
    n_unique: unique.size,
    target_type_real: isClassification ? "classification" : "regression",
    variance,
    std: Math.sqrt(variance),
    mean,
    class_distribution: classDist,
  };
}

// ── Low Variance Check ──

export function checkLowVariance(
  yValues: number[],
  problemType: string,
): { blocked: boolean; code?: string; message?: string } {
  const valid = yValues.filter(v => !isNaN(v) && isFinite(v));
  if (valid.length === 0) return { blocked: false };

  const unique = new Set(valid);

  if (problemType === "regression") {
    if (unique.size <= 3) {
      return {
        blocked: true,
        code: "LOW_VARIANCE_TARGET",
        message: `Target com apenas ${unique.size} valores distintos — variância insuficiente para regressão.`,
      };
    }
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
    const std = Math.sqrt(variance);
    if (std < 1e-10 && variance < 1e-15) {
      return {
        blocked: true,
        code: "LOW_VARIANCE_TARGET",
        message: `Target com variância praticamente zero (std=${std.toExponential(2)}).`,
      };
    }
  }

  if (problemType === "classification" && unique.size < 2) {
    return {
      blocked: true,
      code: "ONLY_ONE_CLASS",
      message: `Apenas ${unique.size} classe encontrada — classificação impossível.`,
    };
  }

  return { blocked: false };
}

// ── Sample Plan ──

export interface SamplePlanResult {
  shouldSample: boolean;
  sampleSize: number;
  strategy: "stratified" | "random" | "full";
}

export function samplePlan(rowCount: number, problemType: string): SamplePlanResult {
  if (rowCount <= TRAINING_ROW_CAP) {
    return { shouldSample: false, sampleSize: rowCount, strategy: "full" };
  }

  let sampleSize: number;
  if (problemType === "classification") {
    sampleSize = Math.min(TRAINING_ROW_CAP, Math.max(30_000, Math.floor(0.02 * rowCount)));
  } else {
    sampleSize = Math.min(TRAINING_ROW_CAP, Math.max(50_000, Math.floor(0.01 * rowCount)));
  }

  return {
    shouldSample: true,
    sampleSize,
    strategy: problemType === "classification" ? "stratified" : "random",
  };
}

// ── Schema Selection Validation ──

export function validateSchemaSelection(
  schemaCols: Set<string>,
  targetCol: string | null,
  featureCols: string[],
  entityKey: string | null,
): { valid: boolean; code?: string; message?: string; missing: string[] } {
  const missing: string[] = [];
  const schemaLower = new Set([...schemaCols].map(c => c.toLowerCase()));

  if (entityKey && !schemaLower.has(entityKey.toLowerCase())) {
    return { valid: false, code: "INVALID_ENTITY_KEY", message: `Entity Key "${entityKey}" não existe no schema.`, missing: [entityKey] };
  }

  // Skip aggregated virtual targets (agg_*) — they are materialized in-memory during temporal aggregation
  const isAggVirtual = targetCol?.startsWith("agg_") ?? false;
  if (targetCol && targetCol !== "_label_" && targetCol !== "label" && !isAggVirtual && !schemaLower.has(targetCol.toLowerCase())) {
    missing.push(targetCol);
  }

  for (const f of featureCols) {
    if (!schemaLower.has(f.toLowerCase())) {
      missing.push(f);
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      code: "INVALID_SCHEMA_SELECTION",
      message: `Colunas ausentes no schema: ${missing.slice(0, 5).join(", ")}`,
      missing,
    };
  }

  return { valid: true, missing: [] };
}

// ── Feature Leakage Filter ──

const LEAKAGE_EXACT_TOKENS = new Set(["label", "target", "y", "predicted", "prob_", "score_", "predicted_class", "predicted_value", "outcome_final", "status_final"]);

export function filterInvalidFeatures(
  featureCols: string[],
  schemaCols: Set<string>,
): { valid: string[]; removed: { col: string; reason: string }[] } {
  const schemaLower = new Set([...schemaCols].map(c => c.toLowerCase()));
  const valid: string[] = [];
  const removed: { col: string; reason: string }[] = [];

  for (const col of featureCols) {
    // Not in schema
    if (!schemaLower.has(col.toLowerCase())) {
      removed.push({ col, reason: "not_in_schema" });
      continue;
    }

    // Exact leakage token match
    const lower = col.toLowerCase().trim();
    if (LEAKAGE_EXACT_TOKENS.has(lower)) {
      removed.push({ col, reason: "leakage_token" });
      continue;
    }

    // Prefix/suffix leakage patterns
    if (lower.startsWith("prob_") || lower.startsWith("score_") || lower.startsWith("predicted_")) {
      removed.push({ col, reason: "leakage_prefix" });
      continue;
    }

    valid.push(col);
  }

  return { valid, removed };
}

// ── Feature Column Classification ──

export interface ColumnClassification {
  name: string;
  type: "numeric" | "categorical" | "date" | "id" | "constant" | "skip";
  reason?: string;
}

export function classifyColumns(
  headers: string[],
  sampleRows: Record<string, any>[],
  targetColumn: string,
  entityKey: string | null,
): ColumnClassification[] {
  const result: ColumnClassification[] = [];
  const sampleSize = Math.min(sampleRows.length, 200);
  const sample = sampleRows.slice(0, sampleSize);

  for (const h of headers) {
    if (h === targetColumn || h === entityKey) {
      result.push({ name: h, type: "skip", reason: h === targetColumn ? "target" : "entity_key" });
      continue;
    }

    const values = sample.map(r => r[h]).filter(v => v !== null && v !== undefined && v !== "");

    if (values.length === 0) {
      result.push({ name: h, type: "constant", reason: "all_null" });
      continue;
    }

    const unique = new Set(values.map(v => String(v)));
    if (unique.size === 1) {
      result.push({ name: h, type: "constant", reason: "single_value" });
      continue;
    }

    const dateCount = values.filter(v => isDateValue(v)).length;
    if (dateCount / values.length > 0.8) {
      result.push({ name: h, type: "date" });
      continue;
    }

    const numericCount = values.filter(v => !isNaN(coerceToNumber(v))).length;
    if (numericCount / values.length > 0.8) {
      const idPattern = /^(id|_id|codigo|cod_|numero|num_|chave|key|uuid|pk|fk|idx|index)/i;
      const idSuffix = /(_id|_key|_code|_cod|_numero|_num|_uuid)$/i;
      const uniqueRatio = unique.size / values.length;
      if ((idPattern.test(h) || idSuffix.test(h)) && uniqueRatio > 0.5) {
        result.push({ name: h, type: "id", reason: "id_pattern_high_cardinality" });
        continue;
      }
      result.push({ name: h, type: "numeric" });
      continue;
    }

    result.push({ name: h, type: "categorical" });
  }

  return result;
}
