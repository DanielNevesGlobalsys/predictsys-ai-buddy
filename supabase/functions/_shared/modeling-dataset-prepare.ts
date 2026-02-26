/**
 * modeling-dataset-prepare.ts
 *
 * Shared preparation utilities for the build-modeling-dataset pipeline.
 * Handles type normalization, date feature derivation, categorical encoding,
 * feature quality filtering, and per-column stats computation.
 *
 * Reuses coerceToNumber from training-prepare-mvp-soft.ts.
 */

import { coerceToNumber, isDateValue } from "./training-prepare-mvp-soft.ts";

// ══════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════

const CATEGORICAL_TOP_K = 50;

const LEAKAGE_BLOCKLIST_TOKENS = [
  "target", "label", "churn", "cancel", "outcome", "death", "dt_obito",
  "discharge", "status_final", "final_status", "resultado", "y_true",
  "y_pred", "output_final", "predicted", "prediction", "score_final",
];

const ID_PATTERNS = /^(id|_id|codigo|cod_|numero|num_|chave|key|uuid|pk|fk|idx|index)/i;
const ID_SUFFIX = /(_id|_key|_code|_cod|_numero|_num|_uuid)$/i;

// ══════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════

export interface SchemaColumn {
  name: string;
  type?: string | null;
}

export interface ColumnStats {
  name: string;
  inferred_type: "numeric" | "categorical" | "date" | "boolean" | "id" | "constant" | "unknown";
  pct_null: number;
  n_unique: number;
  sample_size: number;
}

export interface FeatureQualityResult {
  kept: string[];
  removed: { col: string; reason: string }[];
  warnings: string[];
}

export interface CategoricalEncodingMeta {
  column: string;
  strategy: "ordinal_topk";
  top_k: number;
  categories: string[];
  other_count: number;
}

export interface ModelingPrepareMeta {
  rows_available: number;
  n_features_input: number;
  n_features_final: number;
  removed_features: { col: string; reason: string }[];
  categorical_encoding: {
    strategy: string;
    topK: number;
    columns_encoded_count: number;
    columns: CategoricalEncodingMeta[];
  };
  date_features_created: string[];
  type_coercions: string[];
  warnings: string[];
  schema_source: string;
}

// ══════════════════════════════════════════════════════════════
// 1. Resolve Schema SSOT (server-side, from Supabase client)
// ══════════════════════════════════════════════════════════════

export async function resolveSchemaSSoT(
  supabase: any,
  projectId: string,
): Promise<{
  columns: SchemaColumn[];
  source: string;
  schema_columns_count: number;
  detected_columns_count?: number;
}> {
  const EMPTY = { columns: [], source: "unknown", schema_columns_count: 0 };

  // Priority 1: active_schema_json from project_dataset_state
  const { data: dsState } = await supabase
    .from("project_dataset_state")
    .select("active_schema_json")
    .eq("project_id", projectId)
    .maybeSingle();

  if (dsState) {
    const raw = (dsState as any).active_schema_json;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const cols: SchemaColumn[] = Object.entries(raw)
        .filter(([k]) => !k.startsWith("_"))
        .map(([name, type]) => ({ name, type: typeof type === "string" ? type : null }));
      if (cols.length > 0) {
        return { columns: cols, source: "active_schema_json", schema_columns_count: cols.length };
      }
    }
    // Could be array format
    if (Array.isArray(raw)) {
      const cols: SchemaColumn[] = raw
        .map((item: any) => {
          if (typeof item === "string") return { name: item, type: null };
          if (item?.name) return { name: String(item.name), type: item.type ?? null };
          return null;
        })
        .filter(Boolean) as SchemaColumn[];
      if (cols.length > 0) {
        return { columns: cols, source: "active_schema_json", schema_columns_count: cols.length };
      }
    }
  }

  // Priority 2: sample_json.columns from project_dataset_sample
  const { data: sampleData } = await supabase
    .from("project_dataset_sample")
    .select("sample_json")
    .eq("project_id", projectId)
    .maybeSingle();

  if (sampleData) {
    const sj = (sampleData as any).sample_json as Record<string, any> | null;
    if (sj?.columns && Array.isArray(sj.columns)) {
      const cols: SchemaColumn[] = sj.columns
        .map((item: any) => {
          if (typeof item === "string") return { name: item, type: null };
          if (item?.name) return { name: String(item.name), type: item.type ?? null };
          return null;
        })
        .filter(Boolean) as SchemaColumn[];
      if (cols.length > 0) {
        return {
          columns: cols,
          source: "sample_json.columns",
          schema_columns_count: cols.length,
          detected_columns_count: sj._meta?.detected_columns_count,
        };
      }
    }

    // Priority 3: infer from first row keys
    if (sj?.rows && Array.isArray(sj.rows) && sj.rows.length > 0) {
      const firstRow = sj.rows[0] as Record<string, unknown>;
      const cols: SchemaColumn[] = Object.keys(firstRow).map(k => ({ name: k, type: null }));
      if (cols.length > 0) {
        return { columns: cols, source: "sample_json.rows_keys", schema_columns_count: cols.length };
      }
    }
  }

  return EMPTY;
}

// ══════════════════════════════════════════════════════════════
// 2. Compute per-column stats from sample rows
// ══════════════════════════════════════════════════════════════

export function computeColumnStats(
  rows: Record<string, any>[],
  columns: string[],
): ColumnStats[] {
  const sampleSize = rows.length;
  if (sampleSize === 0) return columns.map(c => ({
    name: c, inferred_type: "unknown" as const, pct_null: 100, n_unique: 0, sample_size: 0,
  }));

  return columns.map(colName => {
    const values = rows.map(r => r[colName]);
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== "" && String(v) !== "null");
    const pctNull = Math.round(((sampleSize - nonNull.length) / sampleSize) * 100);
    const uniqueSet = new Set(nonNull.map(v => String(v).trim().toLowerCase()));
    const nUnique = uniqueSet.size;

    if (nonNull.length === 0) {
      return { name: colName, inferred_type: "constant" as const, pct_null: 100, n_unique: 0, sample_size: sampleSize };
    }

    if (nUnique <= 1) {
      return { name: colName, inferred_type: "constant" as const, pct_null: pctNull, n_unique: nUnique, sample_size: sampleSize };
    }

    // Boolean check
    const boolVals = new Set(["true", "false", "0", "1", "yes", "no", "sim", "não", "nao"]);
    if (nUnique <= 4 && [...uniqueSet].every(v => boolVals.has(v))) {
      return { name: colName, inferred_type: "boolean" as const, pct_null: pctNull, n_unique: nUnique, sample_size: sampleSize };
    }

    // Date check
    const dateSample = nonNull.slice(0, 50);
    const dateCount = dateSample.filter(v => isDateValue(v)).length;
    if (dateCount / dateSample.length > 0.7) {
      return { name: colName, inferred_type: "date" as const, pct_null: pctNull, n_unique: nUnique, sample_size: sampleSize };
    }

    // Numeric check
    const numericSample = nonNull.slice(0, 200);
    const numericCount = numericSample.filter(v => !isNaN(coerceToNumber(v))).length;
    if (numericCount / numericSample.length > 0.8) {
      // ID-like?
      const uniqueRatio = nUnique / sampleSize;
      if ((ID_PATTERNS.test(colName) || ID_SUFFIX.test(colName)) && uniqueRatio > 0.5) {
        return { name: colName, inferred_type: "id" as const, pct_null: pctNull, n_unique: nUnique, sample_size: sampleSize };
      }
      return { name: colName, inferred_type: "numeric" as const, pct_null: pctNull, n_unique: nUnique, sample_size: sampleSize };
    }

    // Categorical (default for strings)
    return { name: colName, inferred_type: "categorical" as const, pct_null: pctNull, n_unique: nUnique, sample_size: sampleSize };
  });
}

// ══════════════════════════════════════════════════════════════
// 3. Feature Quality Filter
// ══════════════════════════════════════════════════════════════

export function featureQualityFilter(
  stats: ColumnStats[],
  targetColumn: string,
  entityKey: string | null,
): FeatureQualityResult {
  const kept: string[] = [];
  const removed: { col: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const col of stats) {
    // Skip target & entity
    if (col.name === targetColumn) continue;
    if (col.name === entityKey) continue;

    // 100% null
    if (col.pct_null >= 100) {
      removed.push({ col: col.name, reason: "ALL_NULL: 100% valores nulos" });
      continue;
    }

    // Constant (n_unique <= 1)
    if (col.n_unique <= 1) {
      removed.push({ col: col.name, reason: "CONSTANT: apenas 1 valor distinto" });
      continue;
    }

    // ID-like (except entity_key)
    if (col.inferred_type === "id") {
      removed.push({ col: col.name, reason: "ID_TECNICO: coluna identificadora removida" });
      continue;
    }

    // Leakage blocklist
    const lowerName = col.name.toLowerCase();
    const isLeakage = LEAKAGE_BLOCKLIST_TOKENS.some(token => lowerName.includes(token));
    if (isLeakage && col.name !== targetColumn) {
      removed.push({ col: col.name, reason: `LEAKAGE_TOKEN: nome contém token suspeito` });
      continue;
    }

    // Very high null (>95%) — warn but keep
    if (col.pct_null > 95) {
      warnings.push(`${col.name}: ${col.pct_null}% nulo — pode ter impacto limitado`);
    }

    kept.push(col.name);
  }

  return { kept, removed, warnings };
}

// ══════════════════════════════════════════════════════════════
// 4. Categorical Encoding (TopK ordinal map)
// ══════════════════════════════════════════════════════════════

export function buildCategoricalEncodings(
  rows: Record<string, any>[],
  categoricalColumns: string[],
  topK: number = CATEGORICAL_TOP_K,
): CategoricalEncodingMeta[] {
  const result: CategoricalEncodingMeta[] = [];

  for (const colName of categoricalColumns) {
    const freq = new Map<string, number>();
    let otherCount = 0;

    for (const row of rows) {
      const val = String(row[colName] ?? "_MISSING_").trim() || "_MISSING_";
      freq.set(val, (freq.get(val) || 0) + 1);
    }

    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const categories = sorted.slice(0, topK).map(([k]) => k);

    for (let i = topK; i < sorted.length; i++) {
      otherCount += sorted[i][1];
    }

    result.push({
      column: colName,
      strategy: "ordinal_topk",
      top_k: topK,
      categories,
      other_count: otherCount,
    });
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// 5. Date Feature Derivation (column-level plan)
// ══════════════════════════════════════════════════════════════

export function planDateFeatures(
  dateColumns: string[],
): { column: string; features: string[] }[] {
  return dateColumns.map(col => ({
    column: col,
    features: [
      `${col}_year`,
      `${col}_month`,
      `${col}_dow`,
      `${col}_day`,
    ],
  }));
}

// ══════════════════════════════════════════════════════════════
// 6. Type Normalization Report
// ══════════════════════════════════════════════════════════════

export function buildTypeNormalizationReport(
  stats: ColumnStats[],
  schemaColumns: SchemaColumn[],
): string[] {
  const coercions: string[] = [];
  const schemaMap = new Map(schemaColumns.map(c => [c.name.toLowerCase(), c.type]));

  for (const col of stats) {
    const schemaType = schemaMap.get(col.name.toLowerCase());
    if (!schemaType) continue;

    const sLower = (schemaType || "").toLowerCase();
    const iLower = col.inferred_type;

    // Schema says numeric but sample says categorical → coercion needed
    if (/^(num|int|float|double|decimal)/.test(sLower) && iLower === "categorical") {
      coercions.push(`${col.name}: schema=${schemaType} → sample=categorical → will coerce to numeric`);
    }
    // Schema says date/timestamp but sample says categorical/unknown
    if (/^(date|timestamp|datetime)/.test(sLower) && (iLower === "categorical" || iLower === "unknown")) {
      coercions.push(`${col.name}: schema=${schemaType} → sample=${iLower} → will parse as date`);
    }
    // Boolean coercion
    if (iLower === "boolean") {
      coercions.push(`${col.name}: detected as boolean → will encode as 0/1`);
    }
  }

  return coercions;
}

// ══════════════════════════════════════════════════════════════
// 7. Full Prepare Pipeline (orchestrator)
// ══════════════════════════════════════════════════════════════

export interface PrepareResult {
  success: boolean;
  status: "ready" | "failed";
  code?: string;
  message_user?: string;
  meta?: ModelingPrepareMeta;
  fix_suggestions?: { label: string; action: string }[];
}

export function runModelingDatasetPrepare(opts: {
  sampleRows: Record<string, any>[];
  schemaColumns: SchemaColumn[];
  schemaSource: string;
  targetColumn: string;
  entityKey: string | null;
  totalRows: number;
}): PrepareResult {
  const { sampleRows, schemaColumns, schemaSource, targetColumn, entityKey, totalRows } = opts;

  // All column names from schema
  const allColumnNames = schemaColumns.map(c => c.name);

  // Validate target exists in schema
  const targetInSchema = allColumnNames.some(c => c.toLowerCase() === targetColumn.toLowerCase());
  if (!targetInSchema && targetColumn !== "label" && targetColumn !== "_label_") {
    return {
      success: false,
      status: "failed",
      code: "TARGET_NOT_IN_SCHEMA",
      message_user: `Target "${targetColumn}" não encontrado no schema consolidado (${allColumnNames.length} colunas).`,
      fix_suggestions: [{ label: "Revisar seleção de target", action: "goto_target_step" }],
    };
  }

  // Compute per-column stats from sample
  const columnStats = computeColumnStats(sampleRows, allColumnNames);

  // Quality filter
  const qualityResult = featureQualityFilter(columnStats, targetColumn, entityKey);

  if (qualityResult.kept.length === 0) {
    return {
      success: false,
      status: "failed",
      code: "MODELING_DATASET_NO_FEATURES",
      message_user: `Nenhuma feature válida restou após filtragem de qualidade. ${qualityResult.removed.length} colunas removidas.`,
      meta: {
        rows_available: totalRows,
        n_features_input: allColumnNames.length,
        n_features_final: 0,
        removed_features: qualityResult.removed.slice(0, 50),
        categorical_encoding: { strategy: "ordinal_topk", topK: CATEGORICAL_TOP_K, columns_encoded_count: 0, columns: [] },
        date_features_created: [],
        type_coercions: [],
        warnings: qualityResult.warnings,
        schema_source: schemaSource,
      },
      fix_suggestions: [
        { label: "Revisar dataset e colunas", action: "goto_data_step" },
        { label: "Importar mais colunas", action: "goto_upload_step" },
      ],
    };
  }

  // Identify column types among kept features
  const keptStats = columnStats.filter(c => qualityResult.kept.includes(c.name));
  const categoricalCols = keptStats.filter(c => c.inferred_type === "categorical").map(c => c.name);
  const dateCols = keptStats.filter(c => c.inferred_type === "date").map(c => c.name);

  // Build categorical encodings
  const encodings = buildCategoricalEncodings(sampleRows, categoricalCols, CATEGORICAL_TOP_K);

  // Plan date features
  const datePlans = planDateFeatures(dateCols);
  const dateFeatureNames = datePlans.flatMap(p => p.features);

  // Type normalization report
  const coercions = buildTypeNormalizationReport(keptStats, schemaColumns);

  // Schema source warning
  const warnings = [...qualityResult.warnings];
  if (schemaSource !== "active_schema_json") {
    warnings.push(`Schema obtido por fallback: ${schemaSource}. Recomendado consolidar schema na ingestão.`);
  }

  const nFeaturesAfterEncoding = qualityResult.kept.length + dateFeatureNames.length;

  const meta: ModelingPrepareMeta = {
    rows_available: totalRows,
    n_features_input: allColumnNames.length,
    n_features_final: nFeaturesAfterEncoding,
    removed_features: qualityResult.removed.slice(0, 50),
    categorical_encoding: {
      strategy: "ordinal_topk",
      topK: CATEGORICAL_TOP_K,
      columns_encoded_count: encodings.length,
      columns: encodings,
    },
    date_features_created: dateFeatureNames,
    type_coercions: coercions,
    warnings,
    schema_source: schemaSource,
  };

  return {
    success: true,
    status: "ready",
    meta,
  };
}
