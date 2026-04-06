import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface DatasetState {
  project_id: string;
  organization_id: string;
  source_type: "upload" | "db" | "lake" | "bi";
  active_dataset_ref: string | null;
  active_schema_json: any;
  row_count: number;
  col_count: number;
  eda_ready: boolean;
  model_ready: boolean;
  manifest_id: string | null;
  virtual_manifest: boolean;
  last_job_id: string | null;
  last_success_at: string | null;
  updated_at: string;
  diagnostics: Record<string, any>;
}

interface FallbackManifest {
  totalRows: number;
  columnsCount: number;
  totalFiles: number;
  edaReady: boolean;
  modelReady: boolean;
  manifestStatus: string;
  blockedReasonEda: string | null;
  blockedReasonModel: string | null;
  edaStrategy: string;
  edaScope: string | null;
  filesWarn: number;
  filesFail: number;
  sourceType: "upload" | "db" | "lake" | "bi";
  virtualManifest: boolean;
  manifestId: string | null;
  coverageStats: any;
}

/**
 * SSOT hook: loads project_dataset_state first, falls back to import_manifests + project data.
 */
export function useDatasetState(projectId: string | undefined) {
  const [state, setState] = useState<DatasetState | null>(null);
  const [fallback, setFallback] = useState<FallbackManifest | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return null;
    setLoading(true);

    try {
      // Try SSOT first
      const { data: dsState } = await supabase
        .from("project_dataset_state")
        .select("*")
        .eq("project_id", projectId)
        .maybeSingle();

      if (dsState && (dsState as any).row_count > 0) {
        const typed = dsState as unknown as DatasetState;
        setState(typed);
        setFallback({
          totalRows: typed.row_count,
          columnsCount: typed.col_count,
          totalFiles: typed.virtual_manifest ? 0 : 1,
          edaReady: typed.eda_ready,
          modelReady: typed.model_ready,
          manifestStatus: typed.eda_ready ? "ok" : "blocked",
          blockedReasonEda: typed.eda_ready ? null : (typed.diagnostics?.blocked_reason_eda || null),
          blockedReasonModel: typed.model_ready ? null : (typed.diagnostics?.blocked_reason_model || null),
          edaStrategy: typed.diagnostics?.eda_strategy || "UNION_BY_NAME",
          edaScope: typed.diagnostics?.eda_scope || null,
          filesWarn: 0,
          filesFail: 0,
          sourceType: typed.source_type,
          virtualManifest: typed.virtual_manifest,
          manifestId: typed.manifest_id,
          coverageStats: typed.diagnostics?.coverage_stats || null,
        });
        setLoaded(true);
        return typed;
      }

      // Fallback to manifest
      const { data: manifest } = await supabase
        .from("import_manifests")
        .select("id, rows_consolidated, columns_final, total_files, status, eda_ready, model_ready, eda_strategy, eda_scope, blocked_reason_eda, blocked_reason_model, files_warn, files_fail, canonical_schema")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (manifest) {
        const rawSchema = (manifest as any).canonical_schema as Record<string, any> || {};
        const coverageStats = rawSchema._coverage_stats || null;

        setFallback({
          totalRows: manifest.rows_consolidated,
          columnsCount: manifest.columns_final,
          totalFiles: manifest.total_files,
          edaReady: manifest.eda_ready !== false,
          modelReady: manifest.model_ready !== false,
          manifestStatus: manifest.status,
          blockedReasonEda: manifest.blocked_reason_eda as string | null,
          blockedReasonModel: manifest.blocked_reason_model as string | null,
          edaStrategy: (manifest.eda_strategy as string) || "UNION_BY_NAME",
          edaScope: manifest.eda_scope as string | null,
          filesWarn: manifest.files_warn || 0,
          filesFail: manifest.files_fail || 0,
          sourceType: "upload",
          virtualManifest: false,
          manifestId: manifest.id,
          coverageStats,
        });
        setState(null);
        setLoaded(true);
        return null;
      }

      // No data at all
      setState(null);
      setFallback(null);
      setLoaded(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Unified accessors
  const rowCount = state?.row_count ?? fallback?.totalRows ?? 0;
  const colCount = state?.col_count ?? fallback?.columnsCount ?? 0;
  const edaReady = state?.eda_ready ?? fallback?.edaReady ?? false;
  const modelReady = state?.model_ready ?? fallback?.modelReady ?? true;
  const sourceType = state?.source_type ?? fallback?.sourceType ?? "upload";
  const isVirtual = state?.virtual_manifest ?? fallback?.virtualManifest ?? false;
  const hasManifest = !!(state?.manifest_id || fallback?.manifestId) || isVirtual;

  // Reset on project switch
  useEffect(() => {
    setState(null);
    setFallback(null);
    setLoaded(false);
  }, [projectId]);

  return {
    state,
    fallback,
    loading,
    loaded,
    load,
    rowCount,
    colCount,
    edaReady,
    modelReady,
    sourceType,
    isVirtual,
    hasManifest,
  };
}
