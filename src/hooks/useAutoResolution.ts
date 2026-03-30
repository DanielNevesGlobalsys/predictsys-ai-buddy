import { useState, useCallback, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Auto-resolution hook: runs PRE on mount, auto-applies results to SSOT,
 * and provides auto-fix capabilities.
 */

export interface AutoResolutionResult {
  target_column: string | null;
  problem_type: "classification" | "regression";
  entity_key: string | null;
  time_column: string | null;
  selected_features: string[];
  excluded_features: string[];
  confidence_score: number;
  justification: string;
  auto_fix_applied: boolean;
  auto_fix_details: string[];
  issues: { severity: "block" | "warn" | "info"; message: string; suggestion?: string }[];
  insights: { label: string; detail: string; ok: boolean }[];
}

const EMPTY_RESULT: AutoResolutionResult = {
  target_column: null,
  problem_type: "classification",
  entity_key: null,
  time_column: null,
  selected_features: [],
  excluded_features: [],
  confidence_score: 0,
  auto_fix_applied: false,
  auto_fix_details: [],
  justification: "",
  issues: [],
  insights: [],
};

export function useAutoResolution(projectId: string | undefined, organizationId: string | undefined) {
  const [result, setResult] = useState<AutoResolutionResult>(EMPTY_RESULT);
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [applied, setApplied] = useState(false);
  const ranRef = useRef(false);

  const resolve = useCallback(async () => {
    if (!projectId || !organizationId) return null;
    setResolving(true);

    try {
      const { data, error } = await supabase.functions.invoke("run-predictive-resolution", {
        body: { project_id: projectId, organization_id: organizationId, mode: "assisted" },
      });

      if (error || !data?.success || !data?.resolution) {
        console.warn("[useAutoResolution] PRE failed, using fallback", error || data?.error);
        // Fallback: read from SSOT
        return await buildFallbackResult();
      }

      const res = data.resolution;
      const prob = res.problem_definition || {};
      const tgt = res.target_definition || {};
      const fp = res.feature_plan || {};
      const val = res.validation || {};
      const conf = res.confidence || {};
      const expl = res.explanation || {};

      const autoFixes: string[] = [];

      // ── AUTO-FIX 1: Target ──
      let targetCol = tgt.target_name || null;
      let problemType = prob.problem_type || "classification";

      if (!targetCol || tgt.mode === "blocked") {
        // Attempt fallback target from SSOT
        const { data: settings } = await supabase
          .from("project_settings")
          .select("target_column")
          .eq("project_id", projectId)
          .maybeSingle();
        if ((settings as any)?.target_column) {
          targetCol = (settings as any).target_column;
          autoFixes.push("Target recuperado do SSOT (PRE não encontrou candidato válido)");
        }
      }

      // ── AUTO-FIX 2: Problem Type consistency ──
      if (targetCol) {
        const { data: colData } = await supabase
          .from("project_columns")
          .select("inferred_type, distinct_count")
          .eq("project_id", projectId)
          .eq("column_name", targetCol)
          .maybeSingle();
        if (colData) {
          const cd = colData as any;
          const isNumeric = ["numeric", "integer", "float", "number", "numérico", "inteiro"].includes((cd.inferred_type || "").toLowerCase());
          const isLowCard = (cd.distinct_count || 0) <= 10;
          if (isNumeric && !isLowCard && problemType === "classification") {
            problemType = "regression";
            autoFixes.push(`Tipo corrigido para regressão (${targetCol} é numérico contínuo)`);
          } else if (!isNumeric && problemType === "regression") {
            problemType = "classification";
            autoFixes.push(`Tipo corrigido para classificação (${targetCol} é categórico)`);
          }
        }
      }

      // ── AUTO-FIX 3: Features cleanup ──
      let includeFeatures = fp.include_features || [];
      let excludeFeatures = fp.exclude_features || [];
      const blockedFeatures = fp.blocked_features || [];

      // Remove target from features
      includeFeatures = includeFeatures.filter((f: string) => f !== targetCol);
      
      // If no features, auto-select from columns
      if (includeFeatures.length === 0) {
        const { data: allCols } = await supabase
          .from("project_columns")
          .select("column_name, inferred_type, null_percent, distinct_count")
          .eq("project_id", projectId);
        
        if (allCols) {
          const entityKey = prob.entity?.entity_key;
          const timeAnchor = prob.time_anchor;
          const structural = new Set([targetCol, entityKey, timeAnchor].filter(Boolean));
          const ID_PATTERNS = /^(id|_id|key|uuid|pk|sk|index|row_number|__)/i;
          const LEAKAGE_PATTERNS = /^(label|target|y_true|y_pred|predicted|score_final|resultado|outcome|status_final)/i;

          includeFeatures = (allCols as any[])
            .filter(c => {
              if (structural.has(c.column_name)) return false;
              if (ID_PATTERNS.test(c.column_name)) return false;
              if (LEAKAGE_PATTERNS.test(c.column_name)) return false;
              if ((c.null_percent || 0) > 95) return false;
              if ((c.distinct_count || 0) <= 1) return false;
              return true;
            })
            .map(c => c.column_name);
          autoFixes.push(`Features auto-selecionadas (${includeFeatures.length} colunas válidas)`);
        }
      }

      // Build insights
      const insights: AutoResolutionResult["insights"] = [
        { label: "Target definido", detail: targetCol || "Não encontrado", ok: !!targetCol },
        { label: "Dataset válido", detail: `${prob.dataset_shape_detected || "desconhecido"}`, ok: val.training_ready !== false },
        { label: "Pronto para treino", detail: val.training_ready ? "Sim" : "Pendente", ok: !!val.training_ready },
      ];

      const finalResult: AutoResolutionResult = {
        target_column: targetCol,
        problem_type: problemType as "classification" | "regression",
        entity_key: prob.entity?.entity_key || null,
        time_column: prob.time_anchor || null,
        selected_features: includeFeatures,
        excluded_features: [...excludeFeatures, ...blockedFeatures],
        confidence_score: conf.overall || 0,
        justification: expl.why_this_target || expl.why_this_problem || "Resolução automática pelo PRE.",
        auto_fix_applied: autoFixes.length > 0,
        auto_fix_details: autoFixes,
        issues: (val.issues_detected || []).map((i: any) => ({
          severity: i.severity,
          message: i.message,
          suggestion: i.suggestion,
        })),
        insights,
      };

      setResult(finalResult);
      setResolved(true);
      return finalResult;
    } catch (err) {
      console.error("[useAutoResolution] Error:", err);
      return await buildFallbackResult();
    } finally {
      setResolving(false);
    }
  }, [projectId, organizationId]);

  // Fallback: build result from existing SSOT data
  const buildFallbackResult = useCallback(async (): Promise<AutoResolutionResult | null> => {
    if (!projectId) return null;
    const { data } = await supabase
      .from("project_settings")
      .select("target_column, problem_type, entity_key, time_anchor_column, feature_columns, excluded_columns")
      .eq("project_id", projectId)
      .maybeSingle();

    if (!data) return null;
    const d = data as any;
    const fallback: AutoResolutionResult = {
      ...EMPTY_RESULT,
      target_column: d.target_column || null,
      problem_type: d.problem_type || "classification",
      entity_key: d.entity_key || null,
      time_column: d.time_anchor_column || null,
      selected_features: Array.isArray(d.feature_columns) ? d.feature_columns : [],
      excluded_features: Array.isArray(d.excluded_columns) ? d.excluded_columns : [],
      confidence_score: d.target_column ? 0.5 : 0,
      justification: "Configuração existente carregada do projeto.",
      auto_fix_applied: false,
      auto_fix_details: [],
      insights: [
        { label: "Target definido", detail: d.target_column || "—", ok: !!d.target_column },
        { label: "Entity Key", detail: d.entity_key || "—", ok: !!d.entity_key },
      ],
    };
    setResult(fallback);
    setResolved(true);
    return fallback;
  }, [projectId]);

  // Auto-apply resolution to SSOT
  const applyToSSOT = useCallback(async (res: AutoResolutionResult) => {
    if (!projectId || applied) return;
    if (!res.target_column) return;

    try {
      await supabase
        .from("project_settings")
        .upsert({
          project_id: projectId,
          target_column: res.target_column,
          active_target_column: res.target_column,
          problem_type: res.problem_type,
          entity_key: res.entity_key,
          time_anchor_column: res.time_column,
          feature_columns: res.selected_features,
          excluded_columns: res.excluded_features,
          target_state: "ready",
          active_target_mode: "column",
          target_source: "manual",
          predictive_resolution_state: "applied",
          updated_at: new Date().toISOString(),
        } as any, { onConflict: "project_id" });

      setApplied(true);
      console.log("[useAutoResolution] Applied to SSOT:", res.target_column);
    } catch (err) {
      console.error("[useAutoResolution] Failed to apply to SSOT:", err);
    }
  }, [projectId, applied]);

  // Auto-run on mount (only once)
  useEffect(() => {
    if (ranRef.current || !projectId || !organizationId) return;
    ranRef.current = true;
    resolve();
  }, [projectId, organizationId, resolve]);

  return {
    result,
    resolving,
    resolved,
    applied,
    resolve,
    applyToSSOT,
    setResult,
  };
}
