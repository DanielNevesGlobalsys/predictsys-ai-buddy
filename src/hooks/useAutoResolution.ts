import { useState, useCallback, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Auto-resolution hook: runs PRE on mount, auto-applies results to SSOT
 * (project_settings + project_model_selection), triggers builder, and provides auto-fix.
 */

export interface AutoResolutionResult {
  target_column: string | null;
  problem_type: "classification" | "regression";
  entity_key: string | null;
  time_column: string | null;
  dataset_build_mode: string | null;
  recommended_grain: string | null;
  recommended_split_strategy: string | null;
  aggregated_target_required: boolean;
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
  dataset_build_mode: null,
  recommended_grain: null,
  recommended_split_strategy: null,
  aggregated_target_required: false,
  selected_features: [],
  excluded_features: [],
  confidence_score: 0,
  auto_fix_applied: false,
  auto_fix_details: [],
  justification: "",
  issues: [],
  insights: [],
};

// ═══ UNIVERSAL MULTI-TABLE STRUCTURAL RULES ═══════════════════════════

const FACT_TABLE_TOKENS = [
  "fato", "fact", "transacao", "transaction", "moviment", "movimento",
  "detalhe", "detail", "evento", "event", "pedido", "order", "venda", "sale",
  "compra", "purchase", "lancamento", "operacao", "ticket", "sinistro",
  "atendimento", "visit", "internacao", "remessa", "pagamento", "payment",
  "recebimento", "pesagem", "lote", "lotecaf",
];

const DIMENSION_TABLE_TOKENS = [
  "dim_", "cadastro", "master", "cliente", "customer", "produto", "product",
  "filial", "branch", "store", "loja", "fornecedor", "supplier",
  "funcionario", "employee", "cooperado", "calendario", "calendar",
  "origem", "origin", "representante", "safra", "produtor", "municipio",
  "regiao", "region", "categoria", "category", "grupo_economico", "segmento",
];

function classifyTable(tableName: string): "fact" | "dimension" | "unknown" {
  const lo = tableName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (FACT_TABLE_TOKENS.some(t => lo.includes(t))) return "fact";
  if (DIMENSION_TABLE_TOKENS.some(t => lo.includes(t))) return "dimension";
  return "unknown";
}

function isFromDimensionTable(columnName: string): boolean {
  if (!columnName.includes(".")) return false;
  const table = columnName.split(".")[0];
  return classifyTable(table) === "dimension";
}

function isFromFactTable(columnName: string): boolean {
  if (!columnName.includes(".")) return true; // single-table = fact by default
  const table = columnName.split(".")[0];
  return classifyTable(table) === "fact" || classifyTable(table) === "unknown";
}

// Universal admin ID block pattern
const ADMIN_BLOCK_PATTERNS = /^(sk_|pk_|fk_|__|celcpr|cel_cpr|matricula|matric|codemp|cod_emp|codpes|codgre|cpf|cnpj|rg|email|e_mail|telefone|phone|celular|endereco|cep|nome|name|razao_social|fantasia)/i;

// Cadastral/dimension time patterns to block
const BAD_TIME_PATTERNS = /\b(data_cad|dt_cad|data_ult|dt_ult|nascimento|birth|cadastro|registro|admiss|data_nasc|ultima_compra|last_purchase|ult_ent|ult_compra|ult_pedido)\b/i;

export function useAutoResolution(projectId: string | undefined, organizationId: string | undefined) {
  const [result, setResult] = useState<AutoResolutionResult>(EMPTY_RESULT);
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [applied, setApplied] = useState(false);
  const [builderStatus, setBuilderStatus] = useState<"idle" | "running" | "done" | "error">("idle");
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
        return await buildFallbackResult();
      }

      const res = data.resolution;
      const prob = res.problem_definition || {};
      const tgt = res.target_definition || {};
      const fp = res.feature_plan || {};
      const val = res.validation || {};
      const conf = res.confidence || {};
      const expl = res.explanation || {};
      const ds = res.dataset_strategy || {};

      const autoFixes: string[] = [];

      // ── AUTO-FIX 1: Target ──
      let targetCol = tgt.target_name || null;
      let problemType = prob.problem_type || "classification";

      if (!targetCol || tgt.mode === "blocked") {
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

      // ── AUTO-FIX 3: Entity/Time — enforce fact table priority ──
      let resolvedEntity = prob.entity?.entity_key || null;
      let resolvedTime = prob.time_anchor || null;

      // If entity came from a dimension table, try to find one from the fact table
      if (resolvedEntity && isFromDimensionTable(resolvedEntity)) {
        const { data: allCols } = await supabase
          .from("project_columns")
          .select("column_name")
          .eq("project_id", projectId);
        if (allCols) {
          const factEntityPatterns = ["codlot", "cod_lote", "lote", "id_cliente", "customer_id", "order_id", "contract_id"];
          const factCols = (allCols as any[]).filter(c => isFromFactTable(c.column_name));
          for (const pattern of factEntityPatterns) {
            const match = factCols.find(c => c.column_name.toLowerCase().includes(pattern));
            if (match) {
              autoFixes.push(`Entity corrigida: ${resolvedEntity} (dimensão) → ${match.column_name} (fato)`);
              resolvedEntity = match.column_name;
              break;
            }
          }
        }
      }

      // If time came from a dimension table or is a cadastral date, find operational date from fact
      if (resolvedTime && (isFromDimensionTable(resolvedTime) || BAD_TIME_PATTERNS.test(resolvedTime))) {
        const { data: allCols } = await supabase
          .from("project_columns")
          .select("column_name, inferred_type")
          .eq("project_id", projectId);
        if (allCols) {
          const opDateTokens = ["datmov", "dt_mov", "data_mov", "data_movimentacao", "data_compra", "data_pedido", "data_venda", "data_recebimento", "data_entrada", "data_pesagem"];
          const factCols = (allCols as any[]).filter(c => isFromFactTable(c.column_name));
          for (const pattern of opDateTokens) {
            const match = factCols.find(c => c.column_name.toLowerCase().includes(pattern));
            if (match) {
              autoFixes.push(`Tempo corrigido: ${resolvedTime} (dimensão/cadastral) → ${match.column_name} (fato)`);
              resolvedTime = match.column_name;
              break;
            }
          }
          // Fallback: any date column from fact table
          if (resolvedTime && (isFromDimensionTable(resolvedTime) || BAD_TIME_PATTERNS.test(resolvedTime))) {
            const factDate = factCols.find(c => {
              const ty = ((c as any).inferred_type || "").toLowerCase();
              return ["date", "datetime", "timestamp", "data", "temporal"].some(d => ty.includes(d));
            });
            if (factDate) {
              autoFixes.push(`Tempo corrigido (fallback): ${resolvedTime} → ${factDate.column_name} (fato)`);
              resolvedTime = factDate.column_name;
            }
          }
        }
      }

      // ── AUTO-FIX 4: Features cleanup ──
      let includeFeatures = fp.include_features || [];
      let excludeFeatures = fp.exclude_features || [];
      const blockedFeatures = fp.blocked_features || [];

      includeFeatures = includeFeatures.filter((f: string) => f !== targetCol);
      
      if (includeFeatures.length === 0) {
        const { data: allCols } = await supabase
          .from("project_columns")
          .select("column_name, inferred_type, null_percent, distinct_count")
          .eq("project_id", projectId);
        
        if (allCols) {
          const structural = new Set([targetCol, resolvedEntity, resolvedTime].filter(Boolean));
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

      // ── Determine dataset_build_mode ──
      const isAggTarget = /^agg_/i.test(targetCol || "");
      const resolvedBuildMode = isAggTarget
        ? "temporal_aggregated"
        : ds.target_build_mode || (ds.aggregated_target_required ? "temporal_aggregated" : null);

      const insights: AutoResolutionResult["insights"] = [
        { label: "Target definido", detail: targetCol || "Não encontrado", ok: !!targetCol },
        { label: "Dataset válido", detail: `${prob.dataset_shape_detected || "desconhecido"}`, ok: val.training_ready !== false },
        { label: "Pronto para treino", detail: val.training_ready ? "Sim" : "Pendente", ok: !!val.training_ready },
      ];

      const finalResult: AutoResolutionResult = {
        target_column: targetCol,
        problem_type: problemType as "classification" | "regression",
        entity_key: resolvedEntity,
        time_column: resolvedTime,
        dataset_build_mode: resolvedBuildMode,
        recommended_grain: prob.entity?.grain || null,
        recommended_split_strategy: ds.split_suggestion || null,
        aggregated_target_required: ds.aggregated_target_required === true || isAggTarget,
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
      .select("target_column, problem_type, entity_key, time_anchor_column, feature_columns, excluded_columns, dataset_build_mode")
      .eq("project_id", projectId)
      .maybeSingle();

    if (!data) return null;
    const d = data as any;
    const isAggTarget = /^agg_/i.test(d.target_column || "");
    const fallback: AutoResolutionResult = {
      ...EMPTY_RESULT,
      target_column: d.target_column || null,
      problem_type: d.problem_type || "classification",
      entity_key: d.entity_key || null,
      time_column: d.time_anchor_column || null,
      dataset_build_mode: isAggTarget ? "temporal_aggregated" : (d.dataset_build_mode || null),
      recommended_grain: d.dataset_build_mode === "temporal_aggregated" ? "entity_time" : null,
      recommended_split_strategy: d.dataset_build_mode === "temporal_aggregated" ? "temporal" : null,
      aggregated_target_required: isAggTarget || d.dataset_build_mode === "temporal_aggregated",
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

  /**
   * ATOMIC apply: writes to project_settings + project_model_selection + triggers builder.
   * Enforces fact-table priority for entity/time and forces temporal_aggregated for agg_* targets.
   */
  const applyToSSOT = useCallback(async (res: AutoResolutionResult, force = false) => {
    if (!projectId || (applied && !force)) return;
    if (!res.target_column) return;

    try {
      // ── GOVERNANCE CHECK: Is there an official target that differs? ──
      const { data: currentSettings } = await supabase
        .from("project_settings")
        .select("official_target, official_problem_type")
        .eq("project_id", projectId)
        .maybeSingle();

      const officialTarget = (currentSettings as any)?.official_target || null;
      const officialProblemType = (currentSettings as any)?.official_problem_type || null;

      if (officialTarget && (officialTarget !== res.target_column || (officialProblemType && officialProblemType !== res.problem_type))) {
        console.log("[useAutoResolution] GOVERNANCE CONFLICT: official differs from recommended", {
          official: { target: officialTarget, problem: officialProblemType },
          recommended: { target: res.target_column, problem: res.problem_type },
        });

        await supabase.from("project_settings").update({
          recommended_target: res.target_column,
          recommended_problem_type: res.problem_type,
          recommended_target_reasoning: res.justification || "Resolução automática pelo PRE.",
          recommended_target_confidence: res.confidence_score,
          governance_conflict: true,
          governance_conflict_details: {
            detected_at: new Date().toISOString(),
            official_target: officialTarget,
            official_problem_type: officialProblemType,
            recommended_target: res.target_column,
            recommended_problem_type: res.problem_type,
            source: "auto_resolution",
          },
        } as any).eq("project_id", projectId);

        setApplied(true);
        return;
      }

      // ── STRUCTURAL VALIDATION: entity/time must not come from dimension ──
      let finalEntity = res.entity_key;
      let finalTime = res.time_column;

      if (finalEntity && isFromDimensionTable(finalEntity)) {
        console.warn(`[useAutoResolution] BLOCKING dimension entity: ${finalEntity}`);
        // Try to find fact entity from project_columns
        const { data: cols } = await supabase
          .from("project_columns")
          .select("column_name")
          .eq("project_id", projectId);
        if (cols) {
          const factEntityPatterns = ["codlot", "cod_lote", "lote", "id_cliente", "customer_id", "order_id"];
          const factCols = (cols as any[]).filter(c => isFromFactTable(c.column_name));
          for (const pattern of factEntityPatterns) {
            const match = factCols.find(c => c.column_name.toLowerCase().includes(pattern));
            if (match) {
              console.log(`[useAutoResolution] Entity override: ${finalEntity} → ${match.column_name}`);
              finalEntity = match.column_name;
              break;
            }
          }
        }
        // If still from dimension after trying, null it out rather than persist wrong
        if (finalEntity && isFromDimensionTable(finalEntity)) {
          console.warn(`[useAutoResolution] Could not find fact entity, nulling dimension entity`);
          finalEntity = null;
        }
      }

      if (finalTime && (isFromDimensionTable(finalTime) || BAD_TIME_PATTERNS.test(finalTime))) {
        console.warn(`[useAutoResolution] BLOCKING dimension/cadastral time: ${finalTime}`);
        const { data: cols } = await supabase
          .from("project_columns")
          .select("column_name, inferred_type")
          .eq("project_id", projectId);
        if (cols) {
          const opDateTokens = ["datmov", "dt_mov", "data_mov", "data_movimentacao", "data_compra", "data_pedido", "data_venda", "data_recebimento"];
          const factCols = (cols as any[]).filter(c => isFromFactTable(c.column_name));
          for (const pattern of opDateTokens) {
            const match = factCols.find(c => c.column_name.toLowerCase().includes(pattern));
            if (match) {
              console.log(`[useAutoResolution] Time override: ${finalTime} → ${match.column_name}`);
              finalTime = match.column_name;
              break;
            }
          }
          if (finalTime && (isFromDimensionTable(finalTime) || BAD_TIME_PATTERNS.test(finalTime))) {
            const factDate = factCols.find(c => {
              const ty = ((c as any).inferred_type || "").toLowerCase();
              return ["date", "datetime", "timestamp", "data"].some(d => ty.includes(d));
            });
            if (factDate) {
              finalTime = factDate.column_name;
            } else {
              finalTime = null;
            }
          }
        }
      }

      console.log("[useAutoResolution] Applying atomically to SSOT...", {
        target: res.target_column,
        problem: res.problem_type,
        entity: finalEntity,
        time: finalTime,
        features: res.selected_features.length,
      });

      const isAggregatedTarget = /^agg_/i.test(res.target_column || "")
        || res.dataset_build_mode === "temporal_aggregated"
        || res.aggregated_target_required;

      // ── UNIVERSAL FEATURE SANITIZATION ──
      const sanitizedFeatures = res.selected_features.filter(f => {
        const colPart = f.includes(".") ? f.split(".").pop()! : f;
        if (ADMIN_BLOCK_PATTERNS.test(colPart)) return false;
        // Block dimension FKs that aren't the official entity
        if (f !== finalEntity && isFromDimensionTable(f)) {
          const cp = colPart.toLowerCase();
          if (["codpes", "codlot", "codgre", "cod_produtor", "cod_cooperado"].some(t => cp.includes(t))) return false;
        }
        return true;
      });
      const removedAdminFeatures = res.selected_features.filter(f => !sanitizedFeatures.includes(f));
      if (removedAdminFeatures.length > 0) {
        console.log("[useAutoResolution] Sanitized admin IDs from features:", removedAdminFeatures);
      }

      // ── FORCE dataset_build_mode for aggregated targets ──
      const finalBuildMode = isAggregatedTarget ? "temporal_aggregated" : (res.dataset_build_mode || "row_level");

      // 1. Update project_settings (SSOT)
      const settingsPayload: Record<string, any> = {
        project_id: projectId,
        target_column: res.target_column,
        active_target_column: res.target_column,
        problem_type: res.problem_type,
        entity_key: finalEntity,
        time_anchor_column: finalTime,
        feature_columns: sanitizedFeatures,
        excluded_columns: [...res.excluded_features, ...removedAdminFeatures],
        target_state: "ready",
        active_target_mode: "column",
        target_source: "manual",
        predictive_resolution_state: "applied",
        official_target: res.target_column,
        official_problem_type: res.problem_type,
        official_entity_key: finalEntity,
        official_time_column: finalTime,
        governance_conflict: false,
        dataset_build_mode: finalBuildMode,
        updated_at: new Date().toISOString(),
      };

      if (finalTime && finalEntity) {
        settingsPayload.recommended_time_column = finalTime;
        settingsPayload.recommended_grain = "entity_time";
        settingsPayload.recommended_split_strategy = "temporal";
        settingsPayload.temporal_readiness_state = "ready";
        settingsPayload.grain_confidence = 0.85;
        settingsPayload.time_strategy_confidence = 0.9;
        settingsPayload.official_grain = "entity_time";
        if (isAggregatedTarget) {
          settingsPayload.dataset_build_mode = "temporal_aggregated";
        }
      }

      await supabase
        .from("project_settings")
        .upsert(settingsPayload as any, { onConflict: "project_id" });

      console.log("[useAutoResolution] project_settings updated:", {
        target: res.target_column,
        entity: finalEntity,
        time: finalTime,
        build_mode: finalBuildMode,
        grain: settingsPayload.recommended_grain || "original_row",
      });

      // 2. Sync project_model_selection via atomic RPC
      const upsertRes = await supabase.functions.invoke("upsert-model-selection", {
        body: {
          project_id: projectId,
          target_column: res.target_column,
          problem_type: res.problem_type,
          selected_features: sanitizedFeatures,
          excluded_features: [...res.excluded_features, ...removedAdminFeatures],
          entity_key: finalEntity,
          time_column: finalTime,
          dataset_build_mode: finalBuildMode,
        },
      });

      if (upsertRes.data?.success) {
        console.log("[useAutoResolution] project_model_selection synced:", {
          version: upsertRes.data.selection_version,
          hash: upsertRes.data.target_hash,
          changed: upsertRes.data.did_change,
        });
      } else {
        console.warn("[useAutoResolution] model_selection upsert issue:", upsertRes.data?.error || upsertRes.error);
      }

      // 3. Auto-trigger builder to generate modeling dataset
      if (res.selected_features.length >= 3) {
        setBuilderStatus("running");
        console.log("[useAutoResolution] Triggering build-modeling-dataset...");
        try {
          const builderRes = await supabase.functions.invoke("build-modeling-dataset", {
            body: { project_id: projectId },
          });
          if (builderRes.data?.success || builderRes.data?.status === "READY") {
            setBuilderStatus("done");
            console.log("[useAutoResolution] Builder completed successfully");
          } else {
            setBuilderStatus("error");
            console.warn("[useAutoResolution] Builder returned:", builderRes.data?.error || builderRes.data?.status);
          }
        } catch (builderErr) {
          setBuilderStatus("error");
          console.warn("[useAutoResolution] Builder failed (non-blocking):", builderErr);
        }
      }

      setApplied(true);
      console.log("[useAutoResolution] FULL atomic apply complete:", res.target_column);
    } catch (err) {
      console.error("[useAutoResolution] Failed to apply to SSOT:", err);
    }
  }, [projectId, applied]);

  // Reset all state when projectId changes
  useEffect(() => {
    setResult(EMPTY_RESULT);
    setResolving(false);
    setResolved(false);
    setApplied(false);
    setBuilderStatus("idle");
    ranRef.current = false;
  }, [projectId]);

  // Auto-run on mount (only once per project)
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
    builderStatus,
    resolve,
    applyToSSOT,
    setResult,
  };
}
