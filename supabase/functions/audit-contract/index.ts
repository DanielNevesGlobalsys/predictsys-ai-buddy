import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface AuditGate {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: Record<string, unknown>;
}

interface AuditAction {
  label: string;
  go_to_step?: number;
  code?: string;
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

    const { project_id, selection_version: reqSelVersion } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[audit-contract] Starting for project ${project_id}`);

    // ===== PARALLEL FETCH =====
    const [selectionRes, aiCtxRes, splitPolicyRes, dsStateRes, modelingDatasetRes, labelBuilderRes] = await Promise.all([
      supabase.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_split_policies").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("*").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_label_builders").select("*").eq("project_id", project_id).eq("status", "ready").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const selection = selectionRes.data as any;
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const splitPolicy = splitPolicyRes.data as any;
    const dsState = dsStateRes.data as any;
    const modelingDataset = modelingDatasetRes.data as any;
    const labelBuilder = labelBuilderRes.data as any;

    const selectionVersion = reqSelVersion || selection?.selection_version || 0;
    const intentContract = aiCtx?.intent_contract || aiCtx?.intent || {};
    const intentBase = intentContract.intent_base || intentContract;
    const domainAdapter = intentContract.domain_adapter || {};
    const contractHints = aiCtx?.contract_hints || {};

    const gates: AuditGate[] = [];
    const actions: AuditAction[] = [];
    let score = 100;

    // ===== GATE 1: CONTRACT_MIN_FIELDS =====
    const entityKey = contractHints.entity_key || null;
    const timeAnchor = contractHints.time_anchor_column || null;
    const requiresTime = intentBase.requires_time_column ?? false;

    if (!entityKey) {
      gates.push({ gate: "CONTRACT_MIN_FIELDS", status: "WARN", message: "Nenhuma chave de entidade detectada. Configure na etapa de EDA.", details: { missing: "entity_key" } });
      score -= 10;
      actions.push({ label: "Configurar chave de entidade", go_to_step: 3 });
    } else if (requiresTime && !timeAnchor) {
      gates.push({ gate: "CONTRACT_MIN_FIELDS", status: "BLOCK", message: "Coluna de tempo obrigatória não detectada.", details: { missing: "time_anchor", requires_time: true } });
      score -= 30;
      actions.push({ label: "Configurar coluna temporal", go_to_step: 4 });
    } else {
      gates.push({ gate: "CONTRACT_MIN_FIELDS", status: "PASS", message: `Contrato OK: entity=${entityKey}${timeAnchor ? `, time=${timeAnchor}` : ""}` });
    }

    // ===== GATE 2: TARGET_SANITY =====
    const targetCol = selection?.target_column || null;
    if (!targetCol) {
      gates.push({ gate: "TARGET_SANITY", status: "BLOCK", message: "Nenhum target selecionado.", details: {} });
      score -= 40;
      actions.push({ label: "Selecionar target", go_to_step: 3 });
    } else {
      // Check label builder preview or target stats
      let targetOk = true;
      if (targetCol === "_label_" && labelBuilder) {
        const preview = labelBuilder.preview_summary as any;
        if (preview) {
          const pr = preview.positive_rate ?? 0.5;
          const topClass = Math.max(pr, 1 - pr);
          if (topClass > 0.98) {
            gates.push({ gate: "TARGET_SANITY", status: "BLOCK", message: `Target degenerado: classe dominante ${(topClass * 100).toFixed(1)}%. Revise template.`, details: { top_class_pct: topClass } });
            score -= 40;
            targetOk = false;
            actions.push({ label: "Revisar Target Builder", go_to_step: 3 });
          } else if (topClass > 0.90) {
            gates.push({ gate: "TARGET_SANITY", status: "WARN", message: `Desbalanceamento no target: ${(topClass * 100).toFixed(1)}% classe dominante.`, details: { top_class_pct: topClass } });
            score -= 20;
            targetOk = false;
          }
        }
      }
      // Check from EDA numeric stats for real targets
      if (targetOk && targetCol !== "_label_") {
        const { data: targetStats } = await supabase
          .from("project_numeric_stats")
          .select("std_value, min_value, max_value")
          .eq("project_id", project_id)
          .eq("column_name", targetCol)
          .maybeSingle();
        if (targetStats && targetStats.std_value !== null && targetStats.std_value < 0.001 && targetStats.min_value === targetStats.max_value) {
          gates.push({ gate: "TARGET_SANITY", status: "BLOCK", message: `Target "${targetCol}" tem variância zero. Escolha outro target.`, details: { std: targetStats.std_value } });
          score -= 40;
          targetOk = false;
          actions.push({ label: "Escolher outro target", go_to_step: 3 });
        }
      }
      if (targetOk) {
        gates.push({ gate: "TARGET_SANITY", status: "PASS", message: `Target "${targetCol}" OK.` });
      }
    }

    // ===== GATE 3: SPLIT_SANITY =====
    if (splitPolicy) {
      const policySelVersion = splitPolicy.selection_version || 0;
      if (policySelVersion < selectionVersion) {
        gates.push({ gate: "SPLIT_SANITY", status: "BLOCK", message: `Split policy desatualizada (v${policySelVersion} vs v${selectionVersion}).`, details: { drift: true } });
        score -= 40;
        actions.push({ label: "Regerar Split Policy", go_to_step: 4, code: "SPLIT_OUTDATED" });
      } else if (splitPolicy.status === "blocked") {
        gates.push({ gate: "SPLIT_SANITY", status: "BLOCK", message: "Split policy bloqueada.", details: { status: splitPolicy.status } });
        score -= 40;
        actions.push({ label: "Revisar Split Policy", go_to_step: 4 });
      } else if (splitPolicy.status === "ready") {
        gates.push({ gate: "SPLIT_SANITY", status: "PASS", message: `Split ${splitPolicy.strategy} v${policySelVersion} pronto.` });
      } else {
        gates.push({ gate: "SPLIT_SANITY", status: "WARN", message: `Split policy status=${splitPolicy.status}.` });
        score -= 15;
      }
    } else if (requiresTime) {
      gates.push({ gate: "SPLIT_SANITY", status: "BLOCK", message: "Split temporal obrigatório mas nenhuma policy criada.", details: {} });
      score -= 40;
      actions.push({ label: "Criar Split Policy", go_to_step: 4 });
    } else {
      gates.push({ gate: "SPLIT_SANITY", status: "WARN", message: "Nenhuma split policy — treino usará split aleatório padrão." });
      score -= 15;
    }

    // ===== GATE 4: LEAKAGE_GUARD =====
    const buildLog = modelingDataset?.build_log as Record<string, any> | null;
    const leakageGuard = buildLog?.leakage_guard;
    const selectedFeatures = (selection?.selected_features as string[]) || [];

    // Check if any leakage keyword still in selected features
    const leakageKeywords = ["target", "label", "churn", "cancel", "outcome", "death", "dt_obito", "discharge", "status_final", "final_status"];
    const watchlist = domainAdapter.leakage_watchlist || [];
    const suspectInSelection = selectedFeatures.filter(f => {
      const fl = f.toLowerCase();
      return leakageKeywords.some(k => fl.includes(k)) || watchlist.some((w: string) => fl.includes(w.toLowerCase()));
    });

    if (suspectInSelection.length > 0) {
      gates.push({ gate: "LEAKAGE_GUARD", status: "BLOCK", message: `${suspectInSelection.length} feature(s) suspeita(s) de leakage ainda selecionada(s).`, details: { suspect_features: suspectInSelection } });
      score -= 40;
      actions.push({ label: "Remover features com leakage", go_to_step: 4 });
    } else if (leakageGuard && leakageGuard.removals_count > 0) {
      gates.push({ gate: "LEAKAGE_GUARD", status: "PASS", message: `Leakage Guard: ${leakageGuard.removals_count} coluna(s) removida(s) automaticamente.`, details: { removals_count: leakageGuard.removals_count } });
    } else {
      gates.push({ gate: "LEAKAGE_GUARD", status: "PASS", message: "Nenhum risco de leakage detectado." });
    }

    // ===== GATE 5: CLASS_BALANCE =====
    const classBalance = aiCtx?.class_balance || {};
    const entityCount = rowCount; // reuse rowCount as proxy for entity count
    if (labelBuilder?.preview_summary?.positive_rate != null) {
      const pr = labelBuilder.preview_summary.positive_rate;
      const topClass = Math.max(pr, 1 - pr);
      const hasBalanceMethod = classBalance.method && classBalance.method !== "none";
      const isSmallDataset = entityCount < 1000;

      if (topClass >= 0.85 && !hasBalanceMethod) {
        // No balancing at all — always WARN
        gates.push({ gate: "CLASS_BALANCE", status: "WARN", message: `Desbalanceamento (${(topClass * 100).toFixed(1)}%) sem policy de balanceamento.`, details: { top_class_pct: topClass, method: "none", entity_count: entityCount } });
        score -= 10;
      } else if (topClass >= 0.85 && hasBalanceMethod && isSmallDataset) {
        // Balancing applied but dataset too small — method alone may be insufficient
        gates.push({ gate: "CLASS_BALANCE", status: "WARN", message: `Balanceamento ${classBalance.method} aplicado, mas dataset pequeno (${entityCount} linhas) — eficácia pode ser limitada.`, details: { top_class_pct: topClass, method: classBalance.method, entity_count: entityCount } });
        score -= 10;
        actions.push({ label: "Considerar mais dados ou ajustar threshold", go_to_step: 2 });
      } else if (topClass >= 0.85 && hasBalanceMethod) {
        gates.push({ gate: "CLASS_BALANCE", status: "PASS", message: `Balanceamento: ${classBalance.method} aplicado (${(topClass * 100).toFixed(1)}% dominante, ${entityCount} linhas).` });
      } else {
        gates.push({ gate: "CLASS_BALANCE", status: "PASS", message: `Classes balanceadas (${(topClass * 100).toFixed(1)}% dominante).` });
      }
    } else {
      gates.push({ gate: "CLASS_BALANCE", status: "PASS", message: "Balanceamento: sem dados de preview (assumindo OK)." });
    }

    // ===== GATE 6: DATA_QUALITY_MIN =====
    const rowCount = dsState?.row_count || 0;
    if (rowCount < 200) {
      gates.push({ gate: "DATA_QUALITY_MIN", status: "WARN", message: `Dataset com apenas ${rowCount} linhas. Mínimo recomendado: 200.`, details: { row_count: rowCount } });
      score -= 10;
    } else {
      gates.push({ gate: "DATA_QUALITY_MIN", status: "PASS", message: `${rowCount} linhas no dataset.` });
    }

    // ===== GATE 7: SCORING_READY =====
    const productionModelId = dsState?.production_model_id || null;
    if (productionModelId) {
      const { data: prodModel } = await supabase
        .from("project_models")
        .select("hyperparameters, algorithm_name, status")
        .eq("id", productionModelId)
        .maybeSingle();
      if (prodModel) {
        const hyper = (prodModel.hyperparameters || {}) as any;
        const hasArtifacts = !!(hyper.model_artifacts?.weights || hyper.model_artifacts?.trees);
        const hasNorm = !!(hyper.normalization?.means);
        const hasFeatureNames = !!(hyper.feature_names?.length);
        if (!hasArtifacts || !hasNorm || !hasFeatureNames) {
          gates.push({ gate: "SCORING_READY", status: "BLOCK", message: "Modelo em produção sem artefatos completos.", details: { hasArtifacts, hasNorm, hasFeatureNames } });
          score -= 20;
          actions.push({ label: "Retreinar modelo", go_to_step: 4 });
        } else {
          gates.push({ gate: "SCORING_READY", status: "PASS", message: `Modelo ${prodModel.algorithm_name} pronto para scoring.` });
        }
      } else {
        gates.push({ gate: "SCORING_READY", status: "WARN", message: "Modelo de produção não encontrado." });
        score -= 10;
      }
    } else {
      gates.push({ gate: "SCORING_READY", status: "WARN", message: "Nenhum modelo em produção (pré-deploy)." });
      actions.push({ label: "Treinar modelos", go_to_step: 5 });
      actions.push({ label: "Ver modelos candidatos", go_to_step: 5 });
    }

    // ===== COMPUTE FINAL =====
    score = Math.max(0, Math.min(100, score));
    const hasBlock = gates.some(g => g.status === "BLOCK");
    const hasWarn = gates.some(g => g.status === "WARN");
    const finalStatus = hasBlock ? "block" : hasWarn ? "warn" : "pass";

    const whatIsGood = gates.filter(g => g.status === "PASS").map(g => g.message);
    const whatIsRisky = gates.filter(g => g.status !== "PASS").map(g => g.message);
    const nextBestActions = actions.map(a => a.label);

    const summary = {
      what_is_good: whatIsGood,
      what_is_risky: whatIsRisky,
      next_best_actions: nextBestActions,
      predictability_score: score,
    };

    // ===== PERSIST =====
    // Get latest audit_version for this project+selection_version
    const { data: lastAudit } = await supabase
      .from("project_contract_audits")
      .select("audit_version")
      .eq("project_id", project_id)
      .eq("selection_version", selectionVersion)
      .order("audit_version", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextAuditVersion = (lastAudit?.audit_version || 0) + 1;

    await supabase.from("project_contract_audits").insert({
      project_id,
      selection_version: selectionVersion,
      audit_version: nextAuditVersion,
      status: finalStatus,
      predictability_score: score,
      gates,
      summary,
    });

    // Update project_ai_context with predictability
    try {
      const { data: existingCtx } = await supabase.from("project_ai_context")
        .select("id, context").eq("project_id", project_id).maybeSingle();
      if (existingCtx) {
        const cur = existingCtx.context as Record<string, any> || {};
        await supabase.from("project_ai_context").update({
          context: { ...cur, predictability: { score, status: finalStatus, gates_count: gates.length, updated_at: new Date().toISOString() } },
          last_updated_at: new Date().toISOString(),
        }).eq("id", existingCtx.id);
      }
    } catch (_) {}

    console.log(`[audit-contract] Done: status=${finalStatus}, score=${score}, gates=${gates.length}`);

    return new Response(JSON.stringify({
      success: true,
      status: finalStatus,
      selection_version: selectionVersion,
      gates,
      predictability_score: score,
      actions,
      summary,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[audit-contract] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
