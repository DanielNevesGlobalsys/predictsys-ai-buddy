/**
 * Schema SSOT — Single Source of Truth for project column schema.
 *
 * Resolution order:
 *  1. project_dataset_state.active_schema_json  (consolidated schema)
 *  2. project_dataset_sample.sample_json.columns (sample-level schema)
 *  3. Object.keys of first row in sample_json.rows (last-resort fallback)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SchemaColumn {
  name: string;
  type?: string | null;
}

export type SchemaSource =
  | "active_schema_json"
  | "sample_json.columns"
  | "sample_json.rows_keys"
  | "unknown";

export interface SchemaSSOTResult {
  columns: SchemaColumn[];
  source: SchemaSource;
  schema_columns_count: number;
  detected_columns_count?: number;
}

/**
 * Normalise active_schema_json (object map {col: type}) into SchemaColumn[].
 */
function normalizeSchemaObject(raw: unknown): SchemaColumn[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([k]) => !k.startsWith("_")) // skip _coverage_stats etc.
    .map(([name, type]) => ({
      name,
      type: typeof type === "string" ? type : null,
    }));
}

/**
 * Normalise sample_json.columns (array of {name, type} or strings).
 */
function normalizeSampleColumns(raw: unknown): SchemaColumn[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") return { name: item, type: null };
    if (item && typeof item === "object" && "name" in item)
      return { name: String(item.name), type: item.type ?? null };
    return null;
  }).filter(Boolean) as SchemaColumn[];
}

export async function getProjectSchemaSSOT(
  supabase: SupabaseClient,
  projectId: string,
): Promise<SchemaSSOTResult> {
  const EMPTY: SchemaSSOTResult = {
    columns: [],
    source: "unknown",
    schema_columns_count: 0,
  };

  if (!projectId) return EMPTY;

  // ── 1. Try active_schema_json from project_dataset_state ──
  const { data: dsState } = await supabase
    .from("project_dataset_state")
    .select("active_schema_json")
    .eq("project_id", projectId)
    .maybeSingle();

  if (dsState) {
    const schema = (dsState as any).active_schema_json;
    const cols = normalizeSchemaObject(schema);
    if (cols.length > 0) {
      // Also try to get detected_columns_count from sample _meta
      let detected: number | undefined;
      try {
        const { data: sample } = await supabase
          .from("project_dataset_sample")
          .select("sample_json")
          .eq("project_id", projectId)
          .maybeSingle();
        if (sample) {
          const sj = (sample as any).sample_json as Record<string, any> | null;
          detected = sj?._meta?.detected_columns_count ?? undefined;
        }
      } catch { /* optional */ }

      return {
        columns: cols,
        source: "active_schema_json",
        schema_columns_count: cols.length,
        detected_columns_count: detected,
      };
    }
  }

  // ── 2. Fallback: sample_json.columns ──
  const { data: sampleData } = await supabase
    .from("project_dataset_sample")
    .select("sample_json")
    .eq("project_id", projectId)
    .maybeSingle();

  if (sampleData) {
    const sj = (sampleData as any).sample_json as Record<string, any> | null;
    if (sj) {
      const cols = normalizeSampleColumns(sj.columns);
      if (cols.length > 0) {
        return {
          columns: cols,
          source: "sample_json.columns",
          schema_columns_count: cols.length,
          detected_columns_count: sj._meta?.detected_columns_count ?? undefined,
        };
      }

      // ── 3. Last-resort: infer from first row keys ──
      if (Array.isArray(sj.rows) && sj.rows.length > 0) {
        const firstRow = sj.rows[0] as Record<string, unknown>;
        const cols: SchemaColumn[] = Object.keys(firstRow).map((k) => ({
          name: k,
          type: null,
        }));
        if (cols.length > 0) {
          return {
            columns: cols,
            source: "sample_json.rows_keys",
            schema_columns_count: cols.length,
            detected_columns_count: cols.length,
          };
        }
      }
    }
  }

  return EMPTY;
}
