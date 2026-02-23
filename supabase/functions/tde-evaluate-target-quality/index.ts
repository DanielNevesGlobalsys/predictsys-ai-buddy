import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ══════════════════════════════════════════════════════════════
// TDE Etapa D — Target Quality Validator + Leakage Detector
// ══════════════════════════════════════════════════════════════

interface QualityGate {
  gate: string;
  status: "OK" | "WARN" | "BLOCK";
  message: string;
}

interface TargetQualityReport {
  quality_score: number; // 0-95
  balance_score: number;
  coverage_score: number;
  stability_score: number | null; // null = N/A
  leakage_score: number;
  weights_used: { balance: number; coverage: number; stability: number; leakage: number };
  na_dimensions: string[];
  stability_na: boolean;
  gates: QualityGate[];
  reasons: string[];
  recommended_actions: string[];
  leakage_suspected: boolean;
  leakage_suspects: { column: string; importance: number; reason: string }[];
  stability_by_period: { period: string; positive_rate: number; total: number }[];
  eligible_entities: number;
  total_rows: number;
  coverage_pct: number;
  positive_rate: number;
  dominant_rate: number;
  classes: number;
  template_id: string | null;
  params_hash: string | null;
  dataset_version: number | null;
  created_at: string;
  quality_label: string;
}

// ── Leakage keywords (heuristic D1) ──────────────────────────
const LEAKAGE_KEYWORDS = [
  "target", "label", "churn", "cancel", "outcome", "death",
  "dt_obito", "discharge", "status_final", "final_status",
  "resultado", "y_true", "y_pred", "output_final", "aprovado",
  "cancelado", "obito", "alta", "saida",
];

const POST_EVENT_TEMPORAL = [
  "updated_at", "finished_at", "end_date", "closed_at",
  "completed_at", "dt_saida", "dt_resultado", "data_fim",
  "resolved_at", "modified_at", "dt_finalizacao",
];

function normalizeCol(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function simpleHash(obj: Record<string, unknown>): string {
  const str = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
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
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[tde-evaluate-target-quality] Starting for project=${project_id}`);

    // ── Fetch SSOT data ──────────────────────────────────────
    const [settingsRes, dsStateRes, aiCtxRes, modelingDsRes, columnsRes] = await Promise.all([
      supabase.from("project_settings").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("*").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_columns").select("column_name, inferred_type").eq("project_id", project_id),
    ]);

    const settings = settingsRes.data as Record<string, any> | null;
    const dsState = dsStateRes.data as Record<string, any> | null;
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const modelingDs = modelingDsRes.data as Record<string, any> | null;
    const allColumns = (columnsRes.data || []) as { column_name: string; inferred_type: string }[];

    const targetSource = settings?.target_source || "manual";
    const targetColumn = settings?.target_column || null;
    const labelBuildResult = settings?.label_build_result as Record<string, any> | null;
    const templateId = settings?.selected_template_id || null;
    const templateParams = settings?.selected_template_params || {};
    const totalRows = dsState?.row_count || 0;

    const gates: QualityGate[] = [];
    const reasons: string[] = [];
    const actions: string[] = [];
    const leakageSuspects: { column: string; importance: number; reason: string }[] = [];

    // ── 1. Coverage Score ─────────────────────────────────────
    let coverageScore = 100;
    let coveragePct = 100;
    let eligibleEntities = 0;
    let positiveRate = 0;
    let dominantRate = 0;
    let classes = 2;

    if (labelBuildResult) {
      eligibleEntities = labelBuildResult.eligible_entities || 0;
      positiveRate = labelBuildResult.positive_rate || 0;
      dominantRate = labelBuildResult.dominant_rate || 0;
      classes = labelBuildResult.classes || 2;
      const rowsUsed = labelBuildResult.rows_used || totalRows;
      coveragePct = totalRows > 0 ? Math.round((rowsUsed / totalRows) * 100) : 0;
    } else if (modelingDs) {
      const buildLog = modelingDs.build_log as Record<string, any> | null;
      const labelReport = buildLog?.training_gate?.label_report;
      if (labelReport) {
        positiveRate = labelReport.positive_rate || 0;
        dominantRate = labelReport.dominant_class_rate || 0;
        classes = labelReport.n_classes || 2;
        coveragePct = 100; // physical column = full coverage
      }
    }

    if (coveragePct < 30) {
      coverageScore = 20;
      gates.push({ gate: "coverage", status: "BLOCK", message: `Cobertura muito baixa: apenas ${coveragePct}% dos dados podem gerar o target. Aumente os dados ou mude o template.` });
      actions.push("Verifique se o dataset tem dados suficientes para o período/janela configurada.");
    } else if (coveragePct < 60) {
      coverageScore = 50;
      gates.push({ gate: "coverage", status: "WARN", message: `Cobertura moderada: ${coveragePct}% dos dados geram o target. Resultados podem ser menos confiáveis.` });
    } else {
      coverageScore = Math.min(100, coveragePct);
      gates.push({ gate: "coverage", status: "OK", message: `Cobertura adequada: ${coveragePct}% dos dados cobertos.` });
    }

    // ── 2. Balance Score ──────────────────────────────────────
    let balanceScore = 100;
    if (classes <= 2 && positiveRate > 0) {
      const minority = Math.min(positiveRate, 1 - positiveRate);
      if (minority < 0.01) {
        balanceScore = 10;
        gates.push({ gate: "balance", status: "BLOCK", message: `Target extremamente desbalanceado: classe minoritária com ${(minority * 100).toFixed(2)}%. Modelo não consegue aprender.` });
        reasons.push("Desbalanceamento extremo: quase todas as observações são da mesma classe.");
        actions.push("Considere mudar a janela temporal ou usar um template diferente para obter mais equilíbrio.");
      } else if (minority < 0.05) {
        balanceScore = 30;
        gates.push({ gate: "balance", status: "WARN", message: `Target bastante desbalanceado: ${(minority * 100).toFixed(1)}% na classe menor. Técnicas de balanceamento serão aplicadas.` });
      } else if (minority < 0.15) {
        balanceScore = 60;
        gates.push({ gate: "balance", status: "OK", message: `Desbalanceamento moderado: ${(minority * 100).toFixed(1)}% na classe menor. Aceitável com class_weight.` });
      } else {
        balanceScore = 100;
        gates.push({ gate: "balance", status: "OK", message: `Balanceamento bom: ${(positiveRate * 100).toFixed(1)}% positivos.` });
      }
    } else if (classes > 2) {
      // Multiclass: check dominant class
      if (dominantRate > 0.9) {
        balanceScore = 30;
        gates.push({ gate: "balance", status: "WARN", message: `Classe dominante com ${(dominantRate * 100).toFixed(1)}% — multiclass desbalanceado.` });
      } else {
        balanceScore = 80;
        gates.push({ gate: "balance", status: "OK", message: `Distribuição multiclass aceitável (dominante: ${(dominantRate * 100).toFixed(1)}%).` });
      }
    }

    // ── 3. Stability Score ────────────────────────────────────
    let stabilityScore: number | null = null;
    let stabilityNA = false;
    const stabilityByPeriod = (labelBuildResult?.stability_by_period || []) as { period: string; positive_rate: number; total: number }[];

    // Check if we have a reliable time key via TDE profile
    const tdeProfile = aiCtx?.tde_profile as Record<string, any> | null;
    const timeCandidate = tdeProfile?.candidates?.time_candidates?.[0];
    const hasReliableTime = timeCandidate && (timeCandidate.score >= 30 || stabilityByPeriod.length >= 2);

    if (stabilityByPeriod.length >= 2 && hasReliableTime) {
      const rates = stabilityByPeriod.map(s => s.positive_rate);
      const meanRate = rates.reduce((a, b) => a + b, 0) / rates.length;
      const maxDev = Math.max(...rates.map(r => Math.abs(r - meanRate)));
      const relativeVar = meanRate > 0 ? maxDev / meanRate : 0;

      if (relativeVar > 0.5) {
        stabilityScore = 20;
        gates.push({ gate: "stability", status: "BLOCK", message: `Drift extremo no target: taxa positiva varia ${(relativeVar * 100).toFixed(0)}% entre períodos.` });
        reasons.push("O target muda drasticamente ao longo do tempo.");
        actions.push("Verifique se a definição do target faz sentido para todos os períodos.");
      } else if (relativeVar > 0.25) {
        stabilityScore = 50;
        gates.push({ gate: "stability", status: "WARN", message: `Drift moderado no target: variação de ${(relativeVar * 100).toFixed(0)}% entre períodos.` });
      } else {
        stabilityScore = 90;
        gates.push({ gate: "stability", status: "OK", message: `Target estável (variação: ${(relativeVar * 100).toFixed(0)}%).` });
      }
    } else {
      stabilityNA = true;
      stabilityScore = null;
      gates.push({ gate: "stability", status: "OK", message: "Estabilidade temporal: N/A (sem coluna de data confiável). Pesos renormalizados." });
    }

    // ── 4. Leakage Score (D1: Heuristic + D2: Empirical proxy) ──
    let leakageScore = 100;
    let leakageSuspected = false;

    // D1: Heuristic — check feature names for leakage patterns
    const buildLog = modelingDs?.build_log as Record<string, any> | null;
    const featuresFinal = buildLog?.feature_report?.features_final as string[] || [];
    const leakageSourceCols = labelBuildResult?.leakage_source_columns as string[] || [];

    for (const feat of featuresFinal) {
      const norm = normalizeCol(feat);
      
      // Check leakage keywords
      for (const kw of LEAKAGE_KEYWORDS) {
        if (norm.includes(kw) && feat !== targetColumn) {
          leakageSuspects.push({ column: feat, importance: 0.9, reason: `Nome contém "${kw}" — provável vazamento do target` });
          break;
        }
      }

      // Check post-event temporal
      for (const kw of POST_EVENT_TEMPORAL) {
        if (norm === kw || norm.endsWith(`_${kw}`)) {
          leakageSuspects.push({ column: feat, importance: 0.7, reason: `Coluna temporal pós-evento` });
          break;
        }
      }
    }

    // Check if label source columns leaked into features
    for (const srcCol of leakageSourceCols) {
      if (featuresFinal.includes(srcCol)) {
        leakageSuspects.push({ column: srcCol, importance: 1.0, reason: "Coluna usada para derivar o target — vazamento direto" });
      }
    }

    // D2: Empirical proxy — check training gate metrics if available
    const trainingGate = buildLog?.training_gate;
    if (trainingGate?.label_report) {
      const uniqueRatio = trainingGate.label_report.unique_ratio;
      // If target has extremely high unique ratio for classification, suspicious
      if (uniqueRatio && uniqueRatio > 0.95 && trainingGate.label_report.n_classes <= 2) {
        leakageSuspects.push({ column: targetColumn || "label", importance: 0.8, reason: "Target com ratio de valores únicos muito alto para classificação binária" });
      }
    }

    // Check feature importances from existing models (empirical D2)
    const { data: existingModels } = await supabase
      .from("project_models")
      .select("id, metrics_json")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingModels) {
      const metrics = existingModels.metrics_json as Record<string, any> | null;
      const auc = metrics?.AUC || metrics?.auc || metrics?.roc_auc;
      if (auc && auc >= 0.98) {
        leakageSuspected = true;
        reasons.push(`AUC de ${(auc as number).toFixed(3)} — suspeitamente alto. Possível vazamento de dados.`);
      }

      // Check feature importances
      const { data: importances } = await supabase
        .from("project_feature_importances")
        .select("feature_name, importance_value")
        .eq("project_model_id", existingModels.id)
        .order("importance_value", { ascending: false })
        .limit(5);

      if (importances && importances.length > 0) {
        const topFeat = importances[0];
        if (topFeat.importance_value > 0.5) {
          leakageSuspects.push({
            column: topFeat.feature_name,
            importance: topFeat.importance_value,
            reason: `Feature dominante (${(topFeat.importance_value * 100).toFixed(0)}% importância) — possível leakage`,
          });
        }
      }
    }

    // Deduplicate suspects
    const uniqueSuspects = new Map<string, typeof leakageSuspects[0]>();
    for (const s of leakageSuspects) {
      const existing = uniqueSuspects.get(s.column);
      if (!existing || s.importance > existing.importance) {
        uniqueSuspects.set(s.column, s);
      }
    }
    const finalSuspects = Array.from(uniqueSuspects.values()).sort((a, b) => b.importance - a.importance).slice(0, 5);

    if (finalSuspects.length > 0) {
      leakageSuspected = leakageSuspected || finalSuspects.some(s => s.importance >= 0.9);
      leakageScore = leakageSuspected ? 20 : 60;
      
      if (leakageSuspected) {
        gates.push({
          gate: "leakage",
          status: "BLOCK",
          message: `Vazamento de dados detectado: ${finalSuspects.length} coluna(s) suspeita(s). Remova-as das features antes de treinar.`,
        });
        actions.push(`Remova as colunas suspeitas: ${finalSuspects.map(s => s.column).join(", ")}`);
      } else {
        gates.push({
          gate: "leakage",
          status: "WARN",
          message: `${finalSuspects.length} coluna(s) com risco moderado de leakage. Revise antes de colocar em produção.`,
        });
      }
    } else {
      gates.push({ gate: "leakage", status: "OK", message: "Nenhum vazamento de dados detectado nas features." });
    }

    // ── 5. Compute overall quality_score with weight renormalization ──
    let wBalance = 0.30, wCoverage = 0.20, wStability = 0.25, wLeakage = 0.25;
    const naDimensions: string[] = [];

    if (stabilityNA) {
      naDimensions.push("stability");
      const redistrib = wStability / 3;
      wBalance += redistrib;
      wCoverage += redistrib;
      wLeakage += redistrib;
      wStability = 0;
    }

    const qualityScore = Math.min(95, Math.round(
      balanceScore * wBalance +
      coverageScore * wCoverage +
      (stabilityScore ?? 0) * wStability +
      leakageScore * wLeakage
    ));

    const weightsUsed = {
      balance: Math.round(wBalance * 100) / 100,
      coverage: Math.round(wCoverage * 100) / 100,
      stability: Math.round(wStability * 100) / 100,
      leakage: Math.round(wLeakage * 100) / 100,
    };

    const qualityLabel = qualityScore >= 80 ? "Excelente" : qualityScore >= 60 ? "Boa" : qualityScore >= 40 ? "Regular" : "Ruim";

    if (qualityScore < 30) {
      gates.push({ gate: "quality_overall", status: "BLOCK", message: `Qualidade do target muito baixa (${qualityScore}/100).` });
    } else if (qualityScore < 60) {
      gates.push({ gate: "quality_overall", status: "WARN", message: `Qualidade do target regular (${qualityScore}/100).` });
    } else {
      gates.push({ gate: "quality_overall", status: "OK", message: `Qualidade do target ${qualityLabel.toLowerCase()} (${qualityScore}/100).` });
    }

    const selectionVersion = settings?.selection_version || null;

    const report: TargetQualityReport = {
      quality_score: qualityScore,
      balance_score: balanceScore,
      coverage_score: coverageScore,
      stability_score: stabilityScore,
      leakage_score: leakageScore,
      weights_used: weightsUsed,
      na_dimensions: naDimensions,
      stability_na: stabilityNA,
      gates,
      reasons,
      recommended_actions: actions,
      leakage_suspected: leakageSuspected,
      leakage_suspects: finalSuspects,
      stability_by_period: stabilityByPeriod,
      eligible_entities: eligibleEntities,
      total_rows: totalRows,
      coverage_pct: coveragePct,
      positive_rate: positiveRate,
      dominant_rate: dominantRate,
      classes,
      template_id: templateId,
      params_hash: templateParams ? simpleHash(templateParams) : null,
      dataset_version: selectionVersion,
      created_at: new Date().toISOString(),
      quality_label: qualityLabel,
    };

    // ── Persist to SSOT ──────────────────────────────────────
    await supabase
      .from("project_settings")
      .update({ target_quality_report: report } as any)
      .eq("project_id", project_id);

    console.log(`[tde-evaluate-target-quality] Done. quality=${qualityScore}, label=${qualityLabel}, leakage=${leakageSuspected}`);

    return new Response(JSON.stringify({ success: true, report }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[tde-evaluate-target-quality] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
