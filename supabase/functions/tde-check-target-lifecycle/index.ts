import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface LifecycleRecommendation {
  type: string;
  message: string;
  go_to_step: number | null;
  cta_label: string;
}

interface TargetLifecycleState {
  current_target_source: string;
  current_template_id: string | null;
  current_template_params: Record<string, unknown> | null;
  target_health_score: number;
  status: "ok" | "warn" | "alert";
  reasons: string[];
  recommendation: LifecycleRecommendation | null;
  last_checked_at: string;
  related_versions: {
    selection_current: number;
    selection_scored: number | null;
    builder_version: number | null;
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[tde-check-target-lifecycle] Starting for project ${project_id}`);

    // Parallel fetch all SSOT data
    const [settingsRes, selectionRes, dsStateRes, monitoringRes, builderRes] = await Promise.all([
      supabase.from("project_settings").select("target_source, selected_template_id, selected_template_params, label_build_result, weak_label_result, human_label_result, target_quality_report").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("selection_version").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("production_model_id, diagnostics").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_monitoring_state" as any).select("health_score, checks, last_run_status").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("selection_version_used, status").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const settings = settingsRes.data as Record<string, any> | null;
    const selection = selectionRes.data as any;
    const dsState = dsStateRes.data as any;
    const monitoring = monitoringRes.data as any;
    const builder = builderRes.data as any;

    const targetSource = settings?.target_source || "manual";
    const templateId = settings?.selected_template_id || null;
    const templateParams = settings?.selected_template_params || null;
    const tqr = settings?.target_quality_report as Record<string, any> | null;
    const wlr = settings?.weak_label_result as Record<string, any> | null;
    const hlr = settings?.human_label_result as Record<string, any> | null;
    const lbr = settings?.label_build_result as Record<string, any> | null;

    const selectionVersionCurrent = selection?.selection_version || 0;
    const diagnostics = dsState?.diagnostics as Record<string, any> | null;
    const selectionVersionScored = diagnostics?.selection_version_scored || null;
    const builderVersion = builder?.selection_version_used || null;

    // ====== CALCULATE HEALTH SCORE ======
    const reasons: string[] = [];
    let scoreA = 100; // quality (40%)
    let scoreB = 100; // coverage+sanity (25%)
    let scoreC = 100; // drift/stability (20%)
    let scoreD = 100; // freshness/version (15%)

    // --- A) Target quality (40%) ---
    if (tqr) {
      scoreA = tqr.quality_score || 0;
      if (scoreA < 50) reasons.push(`Qualidade do target baixa (${scoreA}/100)`);
      if (tqr.leakage_suspected) {
        scoreA = Math.max(0, scoreA - 20);
        reasons.push("Suspeita de vazamento de dados (leakage) detectada");
      }
    } else {
      scoreA = 50; // unknown = assume mediocre
      reasons.push("Qualidade do target ainda não avaliada");
    }

    // --- B) Coverage + sanity (25%) ---
    if (monitoring) {
      const checks = monitoring.checks as any[] || [];
      const coverageCheck = checks.find((c: any) => c.check === "coverage" || c.check === "cobertura");
      const sanityCheck = checks.find((c: any) => c.check === "sanity" || c.check === "sanidade");
      
      if (coverageCheck?.status === "FAILED") { scoreB -= 40; reasons.push("Cobertura de scoring insuficiente"); }
      else if (coverageCheck?.status === "WARN") scoreB -= 15;

      if (sanityCheck?.status === "FAILED") { scoreB -= 40; reasons.push("Sanidade das previsões comprometida"); }
      else if (sanityCheck?.status === "WARN") scoreB -= 15;
    } else {
      // No monitoring yet — neutral
      scoreB = 70;
    }

    // Weak supervision coverage
    if (targetSource === "weak_supervision" && wlr) {
      const coverage = wlr.coverage || 0;
      const conflictRate = wlr.conflict_rate || 0;
      if (coverage < 0.2) { scoreB -= 30; reasons.push(`Cobertura do target assistido muito baixa (${(coverage * 100).toFixed(0)}%)`); }
      if (conflictRate > 0.4) { scoreB -= 20; reasons.push(`Alto conflito entre regras (${(conflictRate * 100).toFixed(0)}%)`); }
    }

    // Human labeling coverage
    if (targetSource === "human_labeling" && hlr) {
      const nLabeled = hlr.n_labeled || 0;
      const seedAUC = hlr.model_metrics?.auc || 0;
      if (nLabeled < 30) { scoreB -= 40; reasons.push(`Apenas ${nLabeled} rótulos humanos (mínimo: 30)`); }
      if (seedAUC < 0.6 && nLabeled >= 30) { scoreB -= 15; reasons.push(`Modelo seed com AUC baixo (${(seedAUC * 100).toFixed(0)}%)`); }
    }

    // --- C) Drift/stability (20%) ---
    if (tqr?.stability_score != null) {
      scoreC = tqr.stability_score;
      if (scoreC < 50) reasons.push("Instabilidade temporal do target detectada");
    }
    if (monitoring) {
      const driftCheck = (monitoring.checks as any[] || []).find((c: any) => c.check === "drift" || c.check === "psi_drift");
      if (driftCheck?.status === "ALERT" || driftCheck?.status === "FAILED") {
        scoreC -= 30;
        reasons.push("Drift significativo (PSI) detectado no scoring");
      } else if (driftCheck?.status === "WARN") {
        scoreC -= 10;
      }
    }

    // --- D) Freshness / version drift (15%) ---
    if (selectionVersionCurrent > 0) {
      if (builderVersion != null && builderVersion < selectionVersionCurrent) {
        scoreD -= 50;
        reasons.push(`Builder desatualizado (v${builderVersion} vs seleção v${selectionVersionCurrent})`);
      }
      if (selectionVersionScored != null && selectionVersionScored < selectionVersionCurrent) {
        scoreD -= 30;
        reasons.push(`Scoring executado com versão antiga (v${selectionVersionScored} vs v${selectionVersionCurrent})`);
      }
    }

    // Label build result gates
    if (lbr?.gates) {
      const hasBlock = (lbr.gates as any[]).some((g: any) => g.status === "BLOCK");
      if (hasBlock) {
        scoreA = Math.max(0, scoreA - 30);
        reasons.push("Label builder com portões bloqueados");
      }
    }

    // Clamp scores
    scoreA = Math.max(0, Math.min(100, scoreA));
    scoreB = Math.max(0, Math.min(100, scoreB));
    scoreC = Math.max(0, Math.min(100, scoreC));
    scoreD = Math.max(0, Math.min(100, scoreD));

    const targetHealthScore = Math.round(scoreA * 0.4 + scoreB * 0.25 + scoreC * 0.2 + scoreD * 0.15);
    const status: "ok" | "warn" | "alert" = targetHealthScore >= 75 ? "ok" : targetHealthScore >= 50 ? "warn" : "alert";

    // ====== RECOMMENDATION ======
    let recommendation: LifecycleRecommendation | null = null;

    if (status !== "ok") {
      // Priority-based recommendations
      if (scoreD < 50 && builderVersion != null && builderVersion < selectionVersionCurrent) {
        recommendation = {
          type: "rebuild_builder",
          message: "A seleção de features mudou. Reconstrua o dataset modelável e rode scoring novamente.",
          go_to_step: 4,
          cta_label: "Reconstruir Dataset Modelável",
        };
      } else if (tqr?.leakage_suspected && scoreA < 40) {
        recommendation = {
          type: "fix_leakage",
          message: "Vazamento de dados detectado. Revise as colunas suspeitas e reconstrua.",
          go_to_step: 3,
          cta_label: "Revisar Leakage",
        };
      } else if (targetSource === "label_builder" && scoreA < 60) {
        recommendation = {
          type: "adjust_template",
          message: "Ajuste os parâmetros do template (janela/threshold) e reconstrua o builder para melhorar a qualidade.",
          go_to_step: 3,
          cta_label: "Ajustar Template",
        };
      } else if (targetSource === "weak_supervision" && wlr && (wlr.coverage < 0.2 || wlr.conflict_rate > 0.4)) {
        recommendation = {
          type: "switch_to_human_labeling",
          message: "Dados insuficientes para inferir target com alta confiança. Ative a rotulagem rápida (Etapa F) ou habilite mais regras.",
          go_to_step: 3,
          cta_label: "Ativar Rotulagem Rápida",
        };
      } else if (targetSource === "human_labeling" && hlr && ((hlr.n_labeled || 0) < 50 || (hlr.model_metrics?.auc || 0) < 0.6)) {
        recommendation = {
          type: "label_more",
          message: "Rotule mais exemplos e retreine o modelo seed para melhorar a generalização.",
          go_to_step: 3,
          cta_label: "Rotular +50 Exemplos",
        };
      } else if (scoreC < 50) {
        recommendation = {
          type: "retrain",
          message: "Drift temporal detectado. Considere retreinar o modelo com dados mais recentes.",
          go_to_step: 4,
          cta_label: "Retreinar Modelo",
        };
      } else {
        recommendation = {
          type: "review",
          message: "Revise a configuração do target e os dados de entrada para melhorar o score.",
          go_to_step: 3,
          cta_label: "Revisar Configuração",
        };
      }
    }

    // ====== PERSIST ======
    const lifecycleState: TargetLifecycleState = {
      current_target_source: targetSource,
      current_template_id: templateId,
      current_template_params: templateParams,
      target_health_score: targetHealthScore,
      status,
      reasons: reasons.slice(0, 5),
      recommendation,
      last_checked_at: new Date().toISOString(),
      related_versions: {
        selection_current: selectionVersionCurrent,
        selection_scored: selectionVersionScored,
        builder_version: builderVersion,
      },
    };

    await supabase.from("project_settings").update({
      target_lifecycle_state: lifecycleState,
      target_last_validated_at: new Date().toISOString(),
    } as any).eq("project_id", project_id);

    console.log(`[tde-check-target-lifecycle] Done: score=${targetHealthScore}, status=${status}, reasons=${reasons.length}`);

    return new Response(JSON.stringify({
      success: true,
      target_lifecycle_state: lifecycleState,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[tde-check-target-lifecycle] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
