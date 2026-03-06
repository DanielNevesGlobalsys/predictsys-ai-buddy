import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: Record<string, unknown>;
}

interface SplitPreview {
  train_rows: number;
  valid_rows: number;
  test_rows: number;
  time_ranges?: { split: string; from: string; to: string }[];
  notes: string[];
}

// ══════ Per-method validation ══════

interface MethodValidation {
  status: "valid" | "blocked";
  reason: string;
}

interface SplitValidationLog {
  temporal: MethodValidation;
  grouped: MethodValidation;
  random: MethodValidation;
  chosen_method: string | null;
  fallback_used: boolean;
}

function validateTemporal(
  timeAnchor: string | null,
  detectedMinDate: Date | null,
  detectedMaxDate: Date | null,
  totalRows: number,
): MethodValidation {
  if (!timeAnchor) {
    return { status: "blocked", reason: "Nenhuma coluna temporal (time_anchor) detectada." };
  }
  if (!detectedMinDate || !detectedMaxDate) {
    return { status: "blocked", reason: `Coluna "${timeAnchor}" não contém datas parseáveis.` };
  }
  if (detectedMaxDate.getTime() === detectedMinDate.getTime()) {
    return { status: "blocked", reason: `Coluna "${timeAnchor}" possui apenas 1 valor de data distinto.` };
  }
  const spanDays = (detectedMaxDate.getTime() - detectedMinDate.getTime()) / (1000 * 60 * 60 * 24);
  if (spanDays < 7) {
    return { status: "blocked", reason: `Range temporal de apenas ${Math.round(spanDays)} dias — mínimo necessário: 7 dias.` };
  }
  // Minimum rows for temporal: need at least 200 for test split (~13%)
  if (totalRows < 300) {
    return { status: "blocked", reason: `Apenas ${totalRows} linhas — mínimo para split temporal: 300.` };
  }
  return { status: "valid", reason: "OK" };
}

function validateGrouped(entityKey: string | null, totalRows: number): MethodValidation {
  if (!entityKey) {
    return { status: "blocked", reason: "Nenhuma entity_key detectada para agrupamento." };
  }
  // Cardinality check will be done by the fact that entityKey exists and has >1 group
  // The system already detects entityKey only if it has good cardinality (5%-95% unique ratio)
  if (totalRows < 100) {
    return { status: "blocked", reason: `Apenas ${totalRows} linhas — mínimo para split agrupado: 100.` };
  }
  return { status: "valid", reason: "OK" };
}

function validateRandom(totalRows: number): MethodValidation {
  if (totalRows < 50) {
    return { status: "blocked", reason: `Apenas ${totalRows} linhas — mínimo para qualquer split: 50.` };
  }
  return { status: "valid", reason: "OK" };
}

// ══════ Date helpers ══════

const formatLocalDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const tryParseDate = (val: unknown): Date | null => {
  if (!val) return null;
  const s = String(val).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const d = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    return !isNaN(d.getTime()) && d.getFullYear() > 1900 ? d : null;
  }
  const brMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (brMatch) {
    const d = new Date(Number(brMatch[3]), Number(brMatch[2]) - 1, Number(brMatch[1]));
    return !isNaN(d.getTime()) && d.getFullYear() > 1900 ? d : null;
  }
  const num = Number(s);
  if (!isNaN(num) && num > 946684800000 && num < 4102444800000) return new Date(num);
  if (!isNaN(num) && num > 946684800 && num < 4102444800) return new Date(num * 1000);
  const d = new Date(s);
  return !isNaN(d.getTime()) && d.getFullYear() > 1900 ? d : null;
};

// ══════ Date detection from multiple sources ══════

async function detectDateRange(
  timeAnchor: string | null,
  edaSnap: any,
  numStats: any[],
  supabase: any,
  projectId: string,
): Promise<{ min: Date | null; max: Date | null; source: string; parseWarning: boolean }> {
  if (!timeAnchor) return { min: null, max: null, source: "none", parseWarning: false };

  // Source 1: EDA snapshot
  if (edaSnap?.eda_json) {
    const eda = edaSnap.eda_json as Record<string, any>;
    const colStats = eda.column_stats || eda.columns || {};
    const anchorStats = colStats[timeAnchor] || {};
    const edaMin = tryParseDate(anchorStats.min || anchorStats.min_value || anchorStats.earliest);
    const edaMax = tryParseDate(anchorStats.max || anchorStats.max_value || anchorStats.latest);
    if (edaMin && edaMax && edaMax > edaMin) {
      return { min: edaMin, max: edaMax, source: "eda_snapshot", parseWarning: false };
    }
    if (eda.temporal_summary) {
      const ts = eda.temporal_summary;
      const tsMin = tryParseDate(ts.min_date || ts.start_date);
      const tsMax = tryParseDate(ts.max_date || ts.end_date);
      if (tsMin && tsMax && tsMax > tsMin) {
        return { min: tsMin, max: tsMax, source: "eda_temporal_summary", parseWarning: false };
      }
    }
  }

  // Source 2: Numeric stats
  const timeStat = (numStats || []).find((n: any) => n.column_name === timeAnchor);
  if (timeStat?.min_value != null && timeStat?.max_value != null) {
    const pMin = tryParseDate(timeStat.min_value);
    const pMax = tryParseDate(timeStat.max_value);
    if (pMin && pMax && pMax > pMin) {
      return { min: pMin, max: pMax, source: "numeric_stats", parseWarning: false };
    }
  }

  // Source 3: Categorical stats
  const { data: catStats } = await supabase
    .from("project_categorical_stats")
    .select("top_categories")
    .eq("project_id", projectId)
    .eq("column_name", timeAnchor)
    .maybeSingle();

  if (catStats?.top_categories) {
    const cats = Array.isArray(catStats.top_categories) ? catStats.top_categories : [];
    const parsed: Date[] = [];
    let failCount = 0;
    for (const cat of cats) {
      const val = typeof cat === "object" ? (cat as any).value || (cat as any).category : cat;
      const d = tryParseDate(val);
      if (d) parsed.push(d); else failCount++;
    }
    if (parsed.length >= 2) {
      parsed.sort((a, b) => a.getTime() - b.getTime());
      return {
        min: parsed[0],
        max: parsed[parsed.length - 1],
        source: "categorical_stats",
        parseWarning: failCount > parsed.length * 0.3,
      };
    }
  }

  return { min: null, max: null, source: "none", parseWarning: false };
}

// ══════ Compute preview for each strategy ══════

function computeTemporalPreview(
  totalRows: number,
  params: Record<string, any>,
  detectedMin: Date,
  detectedMax: Date,
): { preview: SplitPreview; gates: GateResult[] } {
  const trainMonths = params.train_months || 12;
  const validMonths = params.valid_months || 2;
  const testMonths = params.test_months || 1;
  const totalMonths = trainMonths + validMonths + testMonths;

  const trainPct = trainMonths / totalMonths;
  const validPct = validMonths / totalMonths;

  const trainRows = Math.floor(totalRows * trainPct);
  const validRows = Math.floor(totalRows * validPct);
  const testRows = totalRows - trainRows - validRows;

  const totalSpanMs = detectedMax.getTime() - detectedMin.getTime();
  const trainEndMs = detectedMin.getTime() + totalSpanMs * trainPct;
  const validEndMs = trainEndMs + totalSpanMs * validPct;

  const timeRanges = [
    { split: "train", from: formatLocalDate(detectedMin), to: formatLocalDate(new Date(trainEndMs)) },
    { split: "valid", from: formatLocalDate(new Date(trainEndMs)), to: formatLocalDate(new Date(validEndMs)) },
    { split: "test", from: formatLocalDate(new Date(validEndMs)), to: formatLocalDate(detectedMax) },
  ];

  const gates: GateResult[] = [];
  const dataSpanMonths = (detectedMax.getFullYear() - detectedMin.getFullYear()) * 12
    + (detectedMax.getMonth() - detectedMin.getMonth());

  if (trainMonths < 6) {
    gates.push({
      gate: "SPLIT_SANITY",
      status: "WARN",
      message: `Período de treino de ${trainMonths} meses é curto. Recomendado: ≥ 6 meses.`,
      details: { train_months: trainMonths, recommended_min: 6 },
    });
  }
  if (dataSpanMonths > 0 && dataSpanMonths < totalMonths) {
    gates.push({
      gate: "SPLIT_SANITY",
      status: "WARN",
      message: `Dataset cobre ${dataSpanMonths} meses, split solicita ${totalMonths}. Podem existir buracos temporais.`,
      details: { data_span_months: dataSpanMonths, requested_months: totalMonths },
    });
  }
  if (testRows < 200) {
    gates.push({
      gate: "SPLIT_SANITY",
      status: "WARN",
      message: `Split temporal produz ${testRows} linhas de teste (recomendado: ≥200).`,
      details: { test_rows: testRows, min_recommended: 200 },
    });
  }

  return {
    preview: {
      train_rows: trainRows,
      valid_rows: validRows,
      test_rows: testRows,
      time_ranges: timeRanges,
      notes: [`Split temporal: treino=${trainMonths}m, validação=${validMonths}m, teste=${testMonths}m`],
    },
    gates,
  };
}

function computeGroupedPreview(
  totalRows: number,
  entityKey: string,
  params: Record<string, any>,
): { preview: SplitPreview; gates: GateResult[] } {
  const testSize = params.test_size || 0.2;
  const trainRows = Math.floor(totalRows * (1 - testSize) * 0.875);
  const validRows = Math.floor(totalRows * (1 - testSize) * 0.125);
  const testRows = totalRows - trainRows - validRows;

  return {
    preview: {
      train_rows: trainRows,
      valid_rows: validRows,
      test_rows: testRows,
      notes: [`Split por grupo (${entityKey}): ${(testSize * 100).toFixed(0)}% teste`],
    },
    gates: [],
  };
}

function computeRandomPreview(
  totalRows: number,
  params: Record<string, any>,
): { preview: SplitPreview; gates: GateResult[] } {
  const testSize = params.test_size || 0.2;
  const trainRows = Math.floor(totalRows * (1 - testSize) * 0.875);
  const validRows = Math.floor(totalRows * (1 - testSize) * 0.125);
  const testRows = totalRows - trainRows - validRows;

  return {
    preview: {
      train_rows: trainRows,
      valid_rows: validRows,
      test_rows: testRows,
      notes: [`Split aleatório: ${((1 - testSize) * 100).toFixed(0)}% treino, ${(testSize * 100).toFixed(0)}% teste`],
    },
    gates: [],
  };
}

// ══════ Main handler ══════

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id, selection_version, strategy: requestedStrategy, params: requestedParams } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[preview-split-policy] Starting for project ${project_id}, requested=${requestedStrategy || "auto"}`);

    // ══════ Parallel fetch ══════
    const [aiCtxRes, dsStateRes, selectionRes, numStatsRes, projectRes, edaSnapRes] = await Promise.all([
      supabase.from("project_ai_context").select("id, context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("row_count, col_count").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("selection_version").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_numeric_stats").select("column_name, min_value, max_value").eq("project_id", project_id),
      supabase.from("projects").select("dataset_rows, total_rows").eq("id", project_id).maybeSingle(),
      supabase.from("project_eda_snapshots").select("eda_json").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    // ══════ Row count with fallback chain ══════
    let totalRows = dsStateRes.data?.row_count
      || (projectRes.data as any)?.dataset_rows
      || (projectRes.data as any)?.total_rows
      || 0;
    if (totalRows === 0 && numStatsRes.data && numStatsRes.data.length > 0) {
      const idStat = numStatsRes.data.find((n: any) => /^id/i.test(n.column_name));
      const anyStat = idStat || numStatsRes.data[0];
      if (anyStat?.max_value && Number(anyStat.max_value) > 0) {
        totalRows = Math.round(Number(anyStat.max_value));
      }
    }
    if (totalRows === 0 && numStatsRes.data && numStatsRes.data.length > 0) {
      totalRows = 1000;
    }

    const currentSelVersion = selection_version || (selectionRes.data as any)?.selection_version || 1;
    const aiContext = (aiCtxRes.data?.context as Record<string, any>) || {};
    const contractHints = aiContext.contract_hints || {};
    const entityKey: string | null = contractHints.entity_key || null;
    const timeAnchor: string | null = contractHints.time_anchor_column || null;

    if (totalRows === 0) {
      return new Response(JSON.stringify({ error: "Nenhum dado encontrado." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ══════ PHASE 1: Per-method validation ══════
    const dateRange = await detectDateRange(timeAnchor, edaSnapRes.data, numStatsRes.data || [], supabase, project_id);
    console.log(`[preview-split-policy] Date: source=${dateRange.source}, min=${dateRange.min ? formatLocalDate(dateRange.min) : "null"}, max=${dateRange.max ? formatLocalDate(dateRange.max) : "null"}`);

    const temporalValidation = validateTemporal(timeAnchor, dateRange.min, dateRange.max, totalRows);
    const groupedValidation = validateGrouped(entityKey, totalRows);
    const randomValidation = validateRandom(totalRows);

    const validationLog: SplitValidationLog = {
      temporal: temporalValidation,
      grouped: groupedValidation,
      random: randomValidation,
      chosen_method: null,
      fallback_used: false,
    };

    console.log(`[preview-split-policy] Validation: temporal=${temporalValidation.status}, grouped=${groupedValidation.status}, random=${randomValidation.status}`);

    // ══════ PHASE 2: Strategy selection with fallback ══════
    const defaultParams: Record<string, any> = {
      temporal: { train_months: 12, valid_months: 2, test_months: 1, time_grain: "month" },
      random: { test_size: 0.2, seed: 42 },
      grouped: { group_key: entityKey || "", test_size: 0.2, seed: 42 },
    };
    const userParams = requestedParams || {};

    let chosenStrategy: string;
    let fallbackUsed = false;
    const gates: GateResult[] = [];

    if (requestedStrategy) {
      // User explicitly requested a strategy — try it, fallback if blocked
      const validations: Record<string, MethodValidation> = {
        temporal: temporalValidation,
        grouped: groupedValidation,
        random: randomValidation,
      };

      if (validations[requestedStrategy]?.status === "valid") {
        chosenStrategy = requestedStrategy;
      } else {
        // Requested strategy blocked — fallback chain
        gates.push({
          gate: "SPLIT_FALLBACK",
          status: "WARN",
          message: `Estratégia "${requestedStrategy}" indisponível: ${validations[requestedStrategy]?.reason || "requisitos não atendidos"}. Usando fallback automático.`,
          details: { requested: requestedStrategy, reason: validations[requestedStrategy]?.reason },
        });
        fallbackUsed = true;

        // Fallback order: temporal → grouped → random
        if (requestedStrategy !== "temporal" && temporalValidation.status === "valid") {
          chosenStrategy = "temporal";
        } else if (requestedStrategy !== "grouped" && groupedValidation.status === "valid") {
          chosenStrategy = "grouped";
        } else if (randomValidation.status === "valid") {
          chosenStrategy = "random";
        } else {
          // ALL blocked — structural error
          chosenStrategy = "random"; // placeholder
        }
      }
    } else {
      // Auto-detect: temporal → grouped → random
      if (temporalValidation.status === "valid") {
        chosenStrategy = "temporal";
      } else if (groupedValidation.status === "valid") {
        chosenStrategy = "grouped";
        if (timeAnchor) {
          fallbackUsed = true;
          gates.push({
            gate: "SPLIT_FALLBACK",
            status: "WARN",
            message: `Split temporal preferível, mas ${temporalValidation.reason}. Usando split agrupado.`,
            details: { preferred: "temporal", fallback_reason: temporalValidation.reason },
          });
        }
      } else if (randomValidation.status === "valid") {
        chosenStrategy = "random";
        fallbackUsed = true;
        const reasons: string[] = [];
        if (temporalValidation.status === "blocked") reasons.push(`temporal: ${temporalValidation.reason}`);
        if (groupedValidation.status === "blocked") reasons.push(`agrupado: ${groupedValidation.reason}`);
        gates.push({
          gate: "SPLIT_FALLBACK",
          status: "WARN",
          message: `Usando split aleatório como fallback. ${reasons.join("; ")}`,
          details: { reasons },
        });
      } else {
        chosenStrategy = "random"; // will be blocked
      }
    }

    validationLog.chosen_method = chosenStrategy;
    validationLog.fallback_used = fallbackUsed;

    // ══════ Check if ALL methods are blocked ══════
    const allBlocked = temporalValidation.status === "blocked"
      && groupedValidation.status === "blocked"
      && randomValidation.status === "blocked";

    if (allBlocked) {
      gates.push({
        gate: "SPLIT_ALL_BLOCKED",
        status: "BLOCK",
        message: "Todos os métodos de split falharam. Dataset pode ser muito pequeno ou sem colunas adequadas.",
        details: {
          temporal: temporalValidation.reason,
          grouped: groupedValidation.reason,
          random: randomValidation.reason,
        },
      });
    }

    // ══════ Compute preview for chosen strategy ══════
    let preview: SplitPreview;
    let strategyGates: GateResult[] = [];
    const effectiveParams = { ...defaultParams[chosenStrategy] || {}, ...userParams };

    if (chosenStrategy === "temporal" && dateRange.min && dateRange.max) {
      const result = computeTemporalPreview(totalRows, effectiveParams, dateRange.min, dateRange.max);
      preview = result.preview;
      strategyGates = result.gates;

      if (dateRange.parseWarning) {
        strategyGates.push({
          gate: "SPLIT_SANITY",
          status: "WARN",
          message: `Mais de 30% dos valores da coluna "${timeAnchor}" não puderam ser interpretados como data.`,
          details: { time_anchor: timeAnchor },
        });
      }
    } else if (chosenStrategy === "grouped" && entityKey) {
      const result = computeGroupedPreview(totalRows, entityKey, effectiveParams);
      preview = result.preview;
      strategyGates = result.gates;
    } else {
      const result = computeRandomPreview(totalRows, effectiveParams);
      preview = result.preview;
      strategyGates = result.gates;
    }

    gates.push(...strategyGates);

    // If no issues, add PASS
    const hasBlock = gates.some(g => g.status === "BLOCK");
    if (!hasBlock && gates.filter(g => g.status !== "PASS").length === 0) {
      gates.push({
        gate: "SPLIT_SANITY",
        status: "PASS",
        message: `Split ${chosenStrategy} configurado: treino=${preview.train_rows}, validação=${preview.valid_rows}, teste=${preview.test_rows}.`,
      });
    }

    const policyStatus = allBlocked ? "blocked" : "ready";

    // ══════ Persist split policy ══════
    const { data: existing } = await supabase
      .from("project_split_policies")
      .select("id")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const policyPayload = {
      selection_version: currentSelVersion,
      strategy: chosenStrategy,
      time_anchor_column: timeAnchor,
      entity_key_column: entityKey,
      params: effectiveParams,
      status: policyStatus,
      preview: { ...preview, gates, validation_log: validationLog },
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      await supabase.from("project_split_policies").update(policyPayload).eq("id", existing.id);
    } else {
      await supabase.from("project_split_policies").insert({
        project_id,
        ...policyPayload,
      });
    }

    // ══════ Update SSOT: split_state ══════
    try {
      await Promise.resolve(supabase.rpc("rpc_update_pipeline_state", {
        p_project_id: project_id,
        p_stage: "split",
        p_new_state: policyStatus === "ready" ? "ready" : "blocked",
      }));
      console.log(`[preview-split-policy] SSOT split_state → ${policyStatus}`);
    } catch (e: any) {
      console.warn(`[preview-split-policy] Failed to update SSOT split_state:`, e?.message);
    }

    // ══════ Persist split_validation_log in project_settings SSOT ══════
    try {
      await Promise.resolve(supabase
        .from("project_settings")
        .update({
          split_validation_log: validationLog,
          updated_at: new Date().toISOString(),
        })
        .eq("project_id", project_id));
      console.log(`[preview-split-policy] split_validation_log persisted`);
    } catch (e: any) {
      console.warn(`[preview-split-policy] Failed to persist validation_log:`, e?.message);
    }

    // ══════ AI context update ══════
    if (aiCtxRes.data) {
      const currentCtx = aiCtxRes.data.context as Record<string, any> || {};
      await supabase.from("project_ai_context").update({
        context: {
          ...currentCtx,
          split_policy: {
            strategy: chosenStrategy,
            time_anchor_column: timeAnchor,
            entity_key_column: entityKey,
            params: effectiveParams,
            status: policyStatus,
            fallback_used: fallbackUsed,
            validation_log: validationLog,
            preview_summary: { train_rows: preview.train_rows, valid_rows: preview.valid_rows, test_rows: preview.test_rows },
            updated_at: new Date().toISOString(),
          },
        },
        last_updated_at: new Date().toISOString(),
      }).eq("id", aiCtxRes.data.id);
    }

    // ══════ Policy drift check ══════
    const existingPolicyVersion = (await supabase
      .from("project_split_policies")
      .select("selection_version")
      .eq("project_id", project_id)
      .neq("status", "outdated")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()).data;

    if (existingPolicyVersion && existingPolicyVersion.selection_version < currentSelVersion) {
      await supabase.from("project_split_policies")
        .update({ status: "outdated", updated_at: new Date().toISOString() })
        .eq("project_id", project_id)
        .lt("selection_version", currentSelVersion);

      gates.push({
        gate: "POLICY_DRIFT",
        status: "WARN",
        message: `Split policy anterior (v${existingPolicyVersion.selection_version}) ficou desatualizada após mudança de seleção (v${currentSelVersion}).`,
        details: { old_version: existingPolicyVersion.selection_version, new_version: currentSelVersion },
      });
    }

    // ══════ Class balance auto-detection ══════
    let classBalancePolicy: Record<string, any> | null = null;
    const labelBuilder = aiContext.label_builder;
    if (labelBuilder?.preview_summary?.positive_rate) {
      const pr = labelBuilder.preview_summary.positive_rate;
      const topClassPct = Math.max(pr, 1 - pr);
      if (topClassPct > 0.90) {
        const method = topClassPct > 0.95 ? "undersample" : "class_weight";
        classBalancePolicy = { method, threshold: topClassPct, auto_applied: true };
        gates.push({
          gate: "CLASS_BALANCE",
          status: "WARN",
          message: `Desbalanceamento detectado (classe dominante: ${(topClassPct * 100).toFixed(1)}%). Será aplicado ${method} automaticamente.`,
          details: { top_class_pct: topClassPct, method },
        });
      }
    }

    if (aiCtxRes.data && classBalancePolicy) {
      const currentCtx2 = (await supabase.from("project_ai_context").select("context").eq("id", aiCtxRes.data.id).single()).data;
      const ctx2 = (currentCtx2?.context as Record<string, any>) || {};
      await supabase.from("project_ai_context").update({
        context: { ...ctx2, class_balance: { ...classBalancePolicy, updated_at: new Date().toISOString() } },
        last_updated_at: new Date().toISOString(),
      }).eq("id", aiCtxRes.data.id);
    }

    console.log(`[preview-split-policy] Done: strategy=${chosenStrategy}, status=${policyStatus}, fallback=${fallbackUsed}`);

    return new Response(JSON.stringify({
      success: true,
      policy: {
        strategy: chosenStrategy,
        time_anchor_column: timeAnchor,
        entity_key_column: entityKey,
        params: effectiveParams,
      },
      preview,
      gates,
      split_validation_log: validationLog,
      class_balance: classBalancePolicy,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[preview-split-policy] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
