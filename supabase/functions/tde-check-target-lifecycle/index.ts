import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══ Types ═══════════════════════════════════════════════════

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
  dataset_fingerprint: string;
  target_fingerprint: string;
  fingerprint_changed: boolean;
  related_versions: {
    selection_current: number;
    selection_scored: number | null;
    builder_version: number | null;
  };
  dimension_scores: {
    quality: number;
    coverage: number;
    drift: number;
    freshness: number;
  };
  na_dimensions: string[];
}

// ═══ Helpers ═════════════════════════════════════════════════

function stableHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return "fp_" + Math.abs(h).toString(36);
}

function computeDatasetFingerprint(dsState: Record<string, any> | null, manifestId: string | null): string {
  const parts = [
    dsState?.active_dataset_ref || "none",
    String(dsState?.row_count || 0),
    String(dsState?.col_count || 0),
    manifestId || "none",
    dsState?.last_success_at || "none",
  ];
  return stableHash(parts.join("|"));
}

function computeTargetFingerprint(
  targetSource: string,
  templateId: string | null,
  templateParams: Record<string, unknown> | null,
  targetColumn: string | null,
): string {
  const parts = [
    targetSource,
    templateId || "none",
    targetColumn || "none",
    JSON.stringify(templateParams || {}),
  ];
  return stableHash(parts.join("|"));
}

// ═══ Main ════════════════════════════════════════════════════

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

    // ── Parallel fetch SSOT data ──────────────────────────────
    const [settingsRes, selectionRes, dsStateRes, monitoringRes, builderRes, manifestRes] = await Promise.all([
      supabase.from("project_settings").select("target_source, selected_template_id, selected_template_params, target_column, label_build_result, weak_label_result, human_label_result, target_quality_report, target_lifecycle_state, target_last_validated_at").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("selection_version, target_column").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("row_count, col_count, active_dataset_ref, manifest_id, production_model_id, diagnostics, last_success_at").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_monitoring_state" as any).select("health_score, checks, last_run_status").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("selection_version_used, status").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("import_manifests").select("id").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const settings = settingsRes.data as Record<string, any> | null;
    const selection = selectionRes.data as any;
    const dsState = dsStateRes.data as Record<string, any> | null;
    const monitoring = monitoringRes.data as any;
    const builder = builderRes.data as any;

    const targetSource = settings?.target_source || "manual";
    const templateId = settings?.selected_template_id || null;
    const templateParams = settings?.selected_template_params || null;
    const targetColumn = settings?.target_column || selection?.target_column || null;
    const tqr = settings?.target_quality_report as Record<string, any> | null;
    const wlr = settings?.weak_label_result as Record<string, any> | null;
    const hlr = settings?.human_label_result as Record<string, any> | null;
    const lbr = settings?.label_build_result as Record<string, any> | null;
    const prevLifecycle = settings?.target_lifecycle_state as Record<string, any> | null;
    const lastValidatedAt = settings?.target_last_validated_at || null;

    const selectionVersionCurrent = selection?.selection_version || 0;
    const diagnostics = dsState?.diagnostics as Record<string, any> | null;
    const selectionVersionScored = diagnostics?.selection_version_scored || null;
    const builderVersion = builder?.selection_version_used || null;
    const manifestId = dsState?.manifest_id || manifestRes.data?.id || null;

    // ── Compute fingerprints ──────────────────────────────────
    const datasetFP = computeDatasetFingerprint(dsState, manifestId);
    const targetFP = computeTargetFingerprint(targetSource, templateId, templateParams, targetColumn);
    const prevDatasetFP = prevLifecycle?.dataset_fingerprint || null;
    const prevTargetFP = prevLifecycle?.target_fingerprint || null;
    const fingerprintChanged = (prevDatasetFP !== null && prevDatasetFP !== datasetFP) ||
                                (prevTargetFP !== null && prevTargetFP !== targetFP);

    console.log(`[tde-check-target-lifecycle] FP: dataset=${datasetFP} (prev=${prevDatasetFP}), target=${targetFP} (prev=${prevTargetFP}), changed=${fingerprintChanged}`);

    // ── Calculate dimension scores ────────────────────────────
    const reasons: string[] = [];
    const naDimensions: string[] = [];

    // --- A) Quality (40%) ---
    let scoreA = 50; // default: unknown
    if (tqr) {
      scoreA = Math.min(95, tqr.quality_score || 0);
      if (scoreA < 50) reasons.push(`Qualidade do target baixa (${scoreA}/95)`);
      if (tqr.leakage_suspected) {
        scoreA = Math.max(0, scoreA - 20);
        reasons.push("Vazamento de dados (leakage) detectado");
      }
      if (tqr.stability_na) {
        reasons.push("Estabilidade temporal: N/A (sem coluna de data confiável)");
      }
    } else {
      reasons.push("Qualidade do target não avaliada");
    }

    // --- B) Coverage + sanity (25%) ---
    let scoreB = 70; // default when no monitoring
    if (monitoring) {
      scoreB = 100;
      const checks = monitoring.checks as any[] || [];
      const coverageCheck = checks.find((c: any) => c.check === "coverage" || c.check === "cobertura");
      const sanityCheck = checks.find((c: any) => c.check === "sanity" || c.check === "sanidade");
      
      if (coverageCheck?.status === "FAILED") { scoreB -= 40; reasons.push("Cobertura de scoring insuficiente"); }
      else if (coverageCheck?.status === "WARN") scoreB -= 15;

      if (sanityCheck?.status === "FAILED") { scoreB -= 40; reasons.push("Sanidade das previsões comprometida"); }
      else if (sanityCheck?.status === "WARN") scoreB -= 15;
    }

    // Coverage from label build
    if (tqr?.coverage_pct != null && tqr.coverage_pct < 50) {
      scoreB = Math.min(scoreB, 40);
      reasons.push(`Cobertura real do target: ${tqr.coverage_pct}%`);
    }

    // Weak supervision coverage
    if (targetSource === "weak_supervision" && wlr) {
      const coverage = wlr.coverage || 0;
      const conflictRate = wlr.conflict_rate || 0;
      if (coverage < 0.2) { scoreB -= 30; reasons.push(`Cobertura assistida: ${(coverage * 100).toFixed(0)}%`); }
      if (conflictRate > 0.4) { scoreB -= 20; reasons.push(`Conflito entre regras: ${(conflictRate * 100).toFixed(0)}%`); }
    }

    // Human labeling
    if (targetSource === "human_labeling" && hlr) {
      const nLabeled = hlr.n_labeled || 0;
      const seedAUC = hlr.model_metrics?.auc || 0;
      if (nLabeled < 30) { scoreB -= 40; reasons.push(`Apenas ${nLabeled} rótulos (mínimo: 30)`); }
      if (seedAUC < 0.6 && nLabeled >= 30) { scoreB -= 15; reasons.push(`Modelo seed AUC: ${(seedAUC * 100).toFixed(0)}%`); }
    }

    // --- C) Drift/stability (20%) ---
    let scoreC = 70; // default neutral
    if (tqr?.stability_score != null) {
      scoreC = tqr.stability_score;
      if (scoreC < 50) reasons.push(`Drift temporal detectado (estabilidade: ${scoreC}/100)`);
    } else if (tqr?.stability_na) {
      naDimensions.push("drift");
      scoreC = 0; // will be excluded from weighted average
    }

    if (monitoring) {
      const driftCheck = (monitoring.checks as any[] || []).find((c: any) => c.check === "drift" || c.check === "psi_drift");
      if (driftCheck?.status === "ALERT" || driftCheck?.status === "FAILED") {
        scoreC = Math.max(0, scoreC - 30);
        reasons.push("PSI drift significativo no scoring");
      } else if (driftCheck?.status === "WARN") {
        scoreC = Math.max(0, scoreC - 10);
      }
    }

    // --- D) Freshness / version drift (15%) ---
    let scoreD = 100;
    if (selectionVersionCurrent > 0) {
      if (builderVersion != null && builderVersion < selectionVersionCurrent) {
        scoreD -= 50;
        reasons.push(`Builder v${builderVersion} vs seleção v${selectionVersionCurrent}`);
      }
      if (selectionVersionScored != null && selectionVersionScored < selectionVersionCurrent) {
        scoreD -= 30;
        reasons.push(`Scoring v${selectionVersionScored} vs seleção v${selectionVersionCurrent}`);
      }
    }

    // Fingerprint change penalty
    if (fingerprintChanged) {
      scoreD -= 20;
      if (prevDatasetFP !== datasetFP) reasons.push("Dataset mudou desde última validação");
      if (prevTargetFP !== targetFP) reasons.push("Configuração do target mudou desde última validação");
    }

    // Freshness penalty (time since last validation)
    if (lastValidatedAt) {
      const hoursSince = (Date.now() - new Date(lastValidatedAt).getTime()) / (1000 * 60 * 60);
      if (hoursSince > 168) { scoreD -= 15; reasons.push(`Última validação há ${Math.round(hoursSince / 24)} dias`); }
      else if (hoursSince > 48) { scoreD -= 5; }
    } else {
      scoreD -= 10;
    }

    // Label build gates
    if (lbr?.gates) {
      const hasBlock = (lbr.gates as any[]).some((g: any) => g.status === "BLOCK");
      if (hasBlock) {
        scoreA = Math.max(0, scoreA - 30);
        reasons.push("Label builder com portões bloqueados");
      }
    }

    // ── Clamp and compute weighted score ──────────────────────
    scoreA = Math.max(0, Math.min(95, scoreA));
    scoreB = Math.max(0, Math.min(95, scoreB));
    scoreC = Math.max(0, Math.min(95, scoreC));
    scoreD = Math.max(0, Math.min(95, scoreD));

    // Renormalize weights if drift is N/A
    let wA = 0.40, wB = 0.25, wC = 0.20, wD = 0.15;
    if (naDimensions.includes("drift")) {
      const redistrib = wC / 3;
      wA += redistrib;
      wB += redistrib;
      wD += redistrib;
      wC = 0;
    }

    const targetHealthScore = Math.min(95, Math.round(scoreA * wA + scoreB * wB + scoreC * wC + scoreD * wD));
    const status: "ok" | "warn" | "alert" = targetHealthScore >= 70 ? "ok" : targetHealthScore >= 45 ? "warn" : "alert";

    // ── Recommendation ────────────────────────────────────────
    let recommendation: LifecycleRecommendation | null = null;

    if (status !== "ok") {
      if (fingerprintChanged && prevTargetFP !== targetFP) {
        recommendation = {
          type: "recalculate_quality",
          message: "Configuração do target mudou. Reavalie a qualidade e reconstrua o dataset modelável.",
          go_to_step: 3,
          cta_label: "Reavaliar Target",
        };
      } else if (fingerprintChanged && prevDatasetFP !== datasetFP) {
        recommendation = {
          type: "rebuild_after_data_change",
          message: "Dataset mudou desde última validação. Reconstrua o builder e reavalie.",
          go_to_step: 4,
          cta_label: "Reconstruir Dataset",
        };
      } else if (scoreD < 50 && builderVersion != null && builderVersion < selectionVersionCurrent) {
        recommendation = {
          type: "rebuild_builder",
          message: "Seleção de features mudou. Reconstrua o dataset modelável.",
          go_to_step: 4,
          cta_label: "Reconstruir Builder",
        };
      } else if (tqr?.leakage_suspected && scoreA < 40) {
        recommendation = {
          type: "fix_leakage",
          message: "Vazamento detectado. Revise colunas suspeitas.",
          go_to_step: 3,
          cta_label: "Revisar Leakage",
        };
      } else if (targetSource === "label_builder" && scoreA < 60) {
        recommendation = {
          type: "adjust_template",
          message: "Ajuste parâmetros do template para melhorar qualidade.",
          go_to_step: 3,
          cta_label: "Ajustar Template",
        };
      } else if (targetSource === "weak_supervision" && wlr && (wlr.coverage < 0.2 || wlr.conflict_rate > 0.4)) {
        recommendation = {
          type: "switch_to_human_labeling",
          message: "Cobertura/conflito insuficiente. Ative rotulagem rápida.",
          go_to_step: 3,
          cta_label: "Rotulagem Rápida",
        };
      } else if (targetSource === "human_labeling" && hlr && ((hlr.n_labeled || 0) < 50 || (hlr.model_metrics?.auc || 0) < 0.6)) {
        recommendation = {
          type: "label_more",
          message: "Rotule mais exemplos para melhorar generalização.",
          go_to_step: 3,
          cta_label: "Rotular +50",
        };
      } else if (scoreC < 50 && !naDimensions.includes("drift")) {
        recommendation = {
          type: "retrain",
          message: "Drift temporal detectado. Retreine com dados recentes.",
          go_to_step: 4,
          cta_label: "Retreinar",
        };
      } else {
        recommendation = {
          type: "review",
          message: "Revise configuração do target e dados de entrada.",
          go_to_step: 3,
          cta_label: "Revisar",
        };
      }
    }

    // ── Persist ───────────────────────────────────────────────
    const lifecycleState: TargetLifecycleState = {
      current_target_source: targetSource,
      current_template_id: templateId,
      current_template_params: templateParams,
      target_health_score: targetHealthScore,
      status,
      reasons: reasons.slice(0, 8),
      recommendation,
      last_checked_at: new Date().toISOString(),
      dataset_fingerprint: datasetFP,
      target_fingerprint: targetFP,
      fingerprint_changed: fingerprintChanged,
      related_versions: {
        selection_current: selectionVersionCurrent,
        selection_scored: selectionVersionScored,
        builder_version: builderVersion,
      },
      dimension_scores: {
        quality: scoreA,
        coverage: scoreB,
        drift: naDimensions.includes("drift") ? -1 : scoreC,
        freshness: scoreD,
      },
      na_dimensions: naDimensions,
    };

    await supabase.from("project_settings").update({
      target_lifecycle_state: lifecycleState,
      target_last_validated_at: new Date().toISOString(),
    } as any).eq("project_id", project_id);

    console.log(`[tde-check-target-lifecycle] Done: score=${targetHealthScore}, status=${status}, fp_changed=${fingerprintChanged}, reasons=${reasons.length}`);

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
