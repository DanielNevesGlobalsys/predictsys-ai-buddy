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

    console.log(`[preview-split-policy] Starting for project ${project_id}`);

    // Parallel fetch
    const [aiCtxRes, dsStateRes, selectionRes, numStatsRes] = await Promise.all([
      supabase.from("project_ai_context").select("id, context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("row_count, col_count").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("selection_version").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_numeric_stats").select("column_name, min_value, max_value").eq("project_id", project_id),
    ]);

    const totalRows = dsStateRes.data?.row_count || 0;
    const currentSelVersion = selection_version || (selectionRes.data as any)?.selection_version || 1;
    const aiContext = (aiCtxRes.data?.context as Record<string, any>) || {};
    const contractHints = aiContext.contract_hints || {};
    const intentContract = aiContext.intent_contract || aiContext.intent || {};
    const intentBase = intentContract.intent_base || intentContract;
    const domainAdapter = intentContract.domain_adapter || {};

    const entityKey: string | null = contractHints.entity_key || null;
    const timeAnchor: string | null = contractHints.time_anchor_column || null;
    const requiresTime: boolean = intentBase.requires_time_column ?? false;

    if (totalRows === 0) {
      return new Response(JSON.stringify({ error: "Nenhum dado encontrado." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Determine strategy
    let strategy = requestedStrategy || "random";
    const params = requestedParams || {};
    const gates: GateResult[] = [];
    const notes: string[] = [];
    let recommendedPolicy: Record<string, any> | null = null;

    // Auto-detect strategy
    if (!requestedStrategy) {
      if (requiresTime && timeAnchor) {
        strategy = "temporal";
      } else if (entityKey && !timeAnchor) {
        strategy = "grouped";
      } else {
        strategy = "random";
      }
    }

    // SPLIT_SANITY gates
    if (requiresTime && !timeAnchor) {
      gates.push({
        gate: "SPLIT_SANITY",
        status: "BLOCK",
        message: "Split temporal obrigatório, mas nenhuma coluna de data/hora foi detectada. Selecione a coluna de data na Etapa 2.",
        details: { requires_time_column: true, time_anchor: null },
      });
    }

    if (strategy === "random" && timeAnchor && requiresTime) {
      // Strong WARN — user chose random but temporal is recommended
      const objective = (intentBase.declared_objective || intentBase.objective || "").toLowerCase();
      const isChurnLike = /churn|convers|inadimpl|atrit|evas|cancel|reten/.test(objective);
      gates.push({
        gate: "SPLIT_SANITY",
        status: isChurnLike ? "BLOCK" : "WARN",
        message: isChurnLike
          ? `Para objetivos de ${objective.includes("churn") ? "churn" : "conversão"}, split temporal é obrigatório para evitar data leakage. Use split temporal.`
          : "Coluna temporal detectada, mas split aleatório selecionado. Split temporal é recomendado para problemas com dependência temporal.",
        details: { recommended_strategy: "temporal", time_anchor: timeAnchor },
      });
      recommendedPolicy = { strategy: "temporal", params: { train_months: 12, valid_months: 2, test_months: 1, time_grain: "month" } };
    }

    // Compute split preview
    const defaultParams: Record<string, any> = {
      temporal: { train_months: 12, valid_months: 2, test_months: 1, time_grain: "month" },
      random: { test_size: 0.2, seed: 42 },
      grouped: { group_key: entityKey || "", test_size: 0.2, seed: 42 },
    };

    const effectiveParams = { ...defaultParams[strategy] || {}, ...params };

    let preview: SplitPreview;

    if (strategy === "temporal") {
      const trainMonths = effectiveParams.train_months || 12;
      const validMonths = effectiveParams.valid_months || 2;
      const testMonths = effectiveParams.test_months || 1;
      const totalMonths = trainMonths + validMonths + testMonths;

      const trainPct = trainMonths / totalMonths;
      const validPct = validMonths / totalMonths;
      const testPct = testMonths / totalMonths;

      const trainRows = Math.floor(totalRows * trainPct);
      const validRows = Math.floor(totalRows * validPct);
      const testRows = totalRows - trainRows - validRows;

      // Generate time ranges from numeric stats
      const timeStat = (numStatsRes.data || []).find((n: any) => n.column_name === timeAnchor);
      const timeRanges: { split: string; from: string; to: string }[] = [];

      if (timeStat) {
        const now = new Date();
        const totalM = totalMonths;
        const testStart = new Date(now.getFullYear(), now.getMonth() - testMonths, 1);
        const validStart = new Date(testStart.getFullYear(), testStart.getMonth() - validMonths, 1);
        const trainStart = new Date(validStart.getFullYear(), validStart.getMonth() - trainMonths, 1);

        timeRanges.push(
          { split: "train", from: trainStart.toISOString().slice(0, 10), to: validStart.toISOString().slice(0, 10) },
          { split: "valid", from: validStart.toISOString().slice(0, 10), to: testStart.toISOString().slice(0, 10) },
          { split: "test", from: testStart.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
        );
      }

      preview = { train_rows: trainRows, valid_rows: validRows, test_rows: testRows, time_ranges: timeRanges, notes: [] };
      notes.push(`Split temporal: treino=${trainMonths}m, validação=${validMonths}m, teste=${testMonths}m`);

      if (testRows < 200) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "BLOCK",
          message: `Split temporal produz apenas ${testRows} linhas de teste (mínimo: 200). Aumente os dados ou ajuste as proporções.`,
          details: { test_rows: testRows },
        });
      } else if (trainRows < 500) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "WARN",
          message: `Split temporal produz apenas ${trainRows} linhas de treino. Resultados podem ser pouco confiáveis.`,
          details: { train_rows: trainRows },
        });
      }
    } else if (strategy === "grouped") {
      const testSize = effectiveParams.test_size || 0.2;
      const trainRows = Math.floor(totalRows * (1 - testSize) * 0.875);
      const validRows = Math.floor(totalRows * (1 - testSize) * 0.125);
      const testRows = totalRows - trainRows - validRows;

      preview = { train_rows: trainRows, valid_rows: validRows, test_rows: testRows, notes: [] };
      notes.push(`Split por grupo (${entityKey || "entity_key"}): ${(testSize * 100).toFixed(0)}% teste`);

      if (!entityKey) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "WARN",
          message: "Split agrupado selecionado, mas nenhuma entity_key detectada. O split pode não prevenir vazamento entre treino e teste.",
        });
      }
    } else {
      // random
      const testSize = effectiveParams.test_size || 0.2;
      const trainRows = Math.floor(totalRows * (1 - testSize) * 0.875);
      const validRows = Math.floor(totalRows * (1 - testSize) * 0.125);
      const testRows = totalRows - trainRows - validRows;

      preview = { train_rows: trainRows, valid_rows: validRows, test_rows: testRows, notes: [] };
      notes.push(`Split aleatório: ${((1 - testSize) * 100).toFixed(0)}% treino, ${(testSize * 100).toFixed(0)}% teste`);
    }

    preview.notes = notes;

    // If no blocks or warns, add PASS
    if (gates.length === 0) {
      gates.push({
        gate: "SPLIT_SANITY",
        status: "PASS",
        message: `Split ${strategy} configurado: treino=${preview.train_rows}, validação=${preview.valid_rows}, teste=${preview.test_rows}.`,
      });
    }

    const hasBlock = gates.some(g => g.status === "BLOCK");
    const policyStatus = hasBlock ? "blocked" : "ready";

    // Upsert split policy
    const { data: existing } = await supabase
      .from("project_split_policies")
      .select("id")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      await supabase.from("project_split_policies").update({
        selection_version: currentSelVersion,
        strategy,
        time_anchor_column: timeAnchor,
        entity_key_column: entityKey,
        params: effectiveParams,
        status: policyStatus,
        preview: { ...preview, gates },
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
    } else {
      await supabase.from("project_split_policies").insert({
        project_id,
        selection_version: currentSelVersion,
        strategy,
        time_anchor_column: timeAnchor,
        entity_key_column: entityKey,
        params: effectiveParams,
        status: policyStatus,
        preview: { ...preview, gates },
      });
    }

    // Persist summary in AI context
    if (aiCtxRes.data) {
      const currentCtx = aiCtxRes.data.context as Record<string, any> || {};
      await supabase.from("project_ai_context").update({
        context: {
          ...currentCtx,
          split_policy: {
            strategy,
            time_anchor_column: timeAnchor,
            entity_key_column: entityKey,
            params: effectiveParams,
            status: policyStatus,
            preview_summary: { train_rows: preview.train_rows, valid_rows: preview.valid_rows, test_rows: preview.test_rows },
            updated_at: new Date().toISOString(),
          },
        },
        last_updated_at: new Date().toISOString(),
      }).eq("id", aiCtxRes.data.id);
    }

    // CLASS BALANCE auto-detection
    let classBalancePolicy: Record<string, any> | null = null;
    const labelBuilder = aiContext.label_builder;
    if (labelBuilder?.preview_summary?.positive_rate) {
      const pr = labelBuilder.preview_summary.positive_rate;
      const topClassPct = Math.max(pr, 1 - pr);
      if (topClassPct > 0.90) {
        classBalancePolicy = { method: "class_weight", threshold: topClassPct };
        gates.push({
          gate: "CLASS_BALANCE",
          status: "WARN",
          message: `Desbalanceamento detectado (classe dominante: ${(topClassPct * 100).toFixed(1)}%). Será aplicado class_weight automaticamente.`,
          details: { top_class_pct: topClassPct, method: "class_weight" },
        });
      }
    }

    console.log(`[preview-split-policy] Done: strategy=${strategy}, status=${policyStatus}`);

    return new Response(JSON.stringify({
      success: true,
      policy: {
        strategy,
        time_anchor_column: timeAnchor,
        entity_key_column: entityKey,
        params: effectiveParams,
      },
      preview,
      gates,
      recommended_policy: recommendedPolicy,
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
