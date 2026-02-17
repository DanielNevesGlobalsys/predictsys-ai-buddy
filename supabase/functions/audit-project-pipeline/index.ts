import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Types ────────────────────────────────────────────────────────────────────

interface AuditCheckResult {
  status: "ok" | "warning" | "error";
  observations: string[];
}

interface AuditReport {
  overall_coherent: boolean;
  confidence_level: "high" | "medium" | "low";
  stages: {
    eda: AuditCheckResult;
    inference: AuditCheckResult;
    target: AuditCheckResult;
    model: AuditCheckResult;
    dashboard: AuditCheckResult;
  };
  incoherences: string[];
  corrections: string[];
  executive_conclusion: string;
  context_flags: {
    has_eda: boolean;
    has_inference: boolean;
    has_target: boolean;
    has_features: boolean;
    has_model: boolean;
    has_metrics: boolean;
    has_feature_importance: boolean;
    has_predictions: boolean;
    has_dashboard_context: boolean;
  };
  disclaimer: string;
}

// ── Guardrail checks (deterministic) ─────────────────────────────────────────

function runTargetGuardrails(
  targetColumn: string | null,
  problemType: string | null,
  numericStats: any[],
  categoricalStats: any[],
  totalRows: number
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!targetColumn) return { valid: false, warnings: ["Nenhum target selecionado."] };

  // Check categorical target
  const catStat = categoricalStats.find((c: any) => c.column_name === targetColumn);
  if (catStat) {
    if (catStat.distinct_count === 1) {
      warnings.push(`Target "${targetColumn}" tem cardinalidade 1 — INVÁLIDO. Não há variação para prever.`);
      return { valid: false, warnings };
    }
    // Check dominant class
    if (catStat.top_categories && Array.isArray(catStat.top_categories)) {
      const topCats = catStat.top_categories as { category: string; count: number }[];
      if (topCats.length > 0 && totalRows > 0) {
        const dominantPct = (topCats[0].count / totalRows) * 100;
        if (dominantPct > 95) {
          warnings.push(`Classe dominante no target "${targetColumn}" representa ${dominantPct.toFixed(1)}% — modelo terá dificuldade em aprender.`);
        } else if (dominantPct > 90) {
          warnings.push(`Desbalanceamento severo: classe majoritária em "${targetColumn}" é ${dominantPct.toFixed(1)}%.`);
        }
      }
    }
  }

  // Check numeric target for regression
  const numStat = numericStats.find((n: any) => n.column_name === targetColumn);
  if (numStat && problemType === "regression") {
    // Variance near zero
    if (numStat.std_value !== null && numStat.std_value < 0.001) {
      warnings.push(`Target "${targetColumn}" tem variância próxima de zero (std=${numStat.std_value}) — INVÁLIDO para regressão.`);
      return { valid: false, warnings };
    }
    // Sequential ID pattern
    const range = (numStat.max_value || 0) - (numStat.min_value || 0);
    if (range > 0 && totalRows > 10) {
      const expectedRange = totalRows - 1;
      if (Math.abs(range - expectedRange) / expectedRange < 0.15) {
        warnings.push(`Target "${targetColumn}" parece ser um ID sequencial (range ≈ total de linhas) — INVÁLIDO.`);
        return { valid: false, warnings };
      }
    }
    // ID-like name
    const lc = targetColumn.toLowerCase();
    const idPatterns = ["_id", "cod_", "codigo", "num_", "numero", "id_"];
    if (idPatterns.some(p => lc.includes(p)) || lc === "id") {
      warnings.push(`Target "${targetColumn}" tem padrão de nome de ID — verifique se é realmente uma variável alvo válida.`);
    }
  }

  return { valid: warnings.filter(w => w.includes("INVÁLIDO")).length === 0, warnings };
}

function runModelGuardrails(
  metrics: { metric_name: string; metric_value: number }[],
  problemType: string,
  featureImportances: { feature_name: string; importance_value: number }[]
): { adequate: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (problemType === "regression") {
    const r2 = metrics.find(m => m.metric_name === "R²")?.metric_value;
    if (r2 !== undefined && r2 < 0) {
      warnings.push(`R² negativo (${r2.toFixed(4)}) — modelo é pior que o baseline. NÃO deve ser promovido para produção.`);
      return { adequate: false, warnings };
    }
    if (r2 !== undefined && r2 < 0.1) {
      warnings.push(`R² muito baixo (${r2.toFixed(4)}) — modelo explica menos de 10% da variação.`);
    }
  } else {
    const auc = metrics.find(m => m.metric_name === "AUC")?.metric_value;
    if (auc !== undefined && auc < 0.55) {
      warnings.push(`AUC abaixo de 0.55 (${auc.toFixed(4)}) — modelo tem capacidade preditiva muito baixa. NÃO deve ser promovido.`);
      return { adequate: false, warnings };
    }
    if (auc !== undefined && auc < 0.65) {
      warnings.push(`AUC baixo (${auc.toFixed(4)}) — modelo tem capacidade preditiva limitada.`);
    }
  }

  // Check if all predictions are constant (no variance in metrics)
  const allMetricsZero = metrics.every(m => m.metric_value === 0);
  if (allMetricsZero && metrics.length > 0) {
    warnings.push("Todas as métricas são zero — possível colapso do modelo (previsões constantes).");
    return { adequate: false, warnings };
  }

  // Check for ID columns in top feature importances
  const topFeatures = featureImportances.slice(0, 5);
  const idFeatures = topFeatures.filter(f => {
    const lc = f.feature_name.toLowerCase();
    return lc === "id" || lc.includes("_id") || lc.startsWith("id_") || lc.includes("cod_") || lc.includes("codigo");
  });
  if (idFeatures.length > 0) {
    warnings.push(`Colunas de ID entre as top features: ${idFeatures.map(f => f.feature_name).join(", ")} — possível vazamento semântico (data leakage).`);
  }

  return { adequate: warnings.filter(w => w.includes("NÃO deve")).length === 0, warnings };
}

// ── Main Handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Autenticação necessária" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id, language = "pt", pipeline_stage = "production" } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id é obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isTrainingStage = pipeline_stage === "training";
    const isPredictionsStage = pipeline_stage === "predictions";

    console.log(`[audit-pipeline] Starting audit for project ${project_id}`);

    // ── Gather ALL project context in parallel ──────────────────────────────

    const [
      projectRes,
      settingsRes,
      aiCtxRes,
      inferenceRes,
      edaInsightsRes,
      numericStatsRes,
      categoricalStatsRes,
      modelsRes,
      predictionsCountRes,
    ] = await Promise.all([
      supabase.from("projects").select("name, problem_type, target_column, status, business_objective, dataset_rows, dataset_columns").eq("id", project_id).single(),
      supabase.from("project_settings").select("target_column, problem_type, feature_columns, excluded_columns").eq("project_id", project_id).maybeSingle(),
      serviceClient.from("project_ai_context").select("context, last_updated_at, status").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_problem_inference").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_eda_insights").select("insights").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_numeric_stats").select("column_name, min_value, max_value, mean_value, median_value, std_value, null_count").eq("project_id", project_id),
      supabase.from("project_categorical_stats").select("column_name, distinct_count, top_categories").eq("project_id", project_id),
      supabase.from("project_models").select("id, algorithm_name, status, is_production, problem_type").eq("project_id", project_id),
      supabase.from("project_prediction_state").select("predictions_count, latest_batch_id, status").eq("project_id", project_id).maybeSingle(),
    ]);

    const project = projectRes.data;
    if (!project) {
      return new Response(JSON.stringify({ error: "Projeto não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const settings = settingsRes.data;
    const aiCtx = aiCtxRes.data?.context as Record<string, any> | null;
    const inference = inferenceRes.data;
    const edaInsights = edaInsightsRes.data;
    const numericStats = numericStatsRes.data || [];
    const categoricalStats = categoricalStatsRes.data || [];
    const models = modelsRes.data || [];
    const predictionsCount = (predictionsCountRes.data as any)?.predictions_count || 0;

    // Get metrics and feature importances for trained models
    const trainedModels = models.filter(m => m.status === "trained");
    let bestModelMetrics: { metric_name: string; metric_value: number }[] = [];
    let featureImportances: { feature_name: string; importance_value: number }[] = [];

    if (trainedModels.length > 0) {
      const productionModel = trainedModels.find(m => m.is_production) || trainedModels[0];
      const [metricsRes, fiRes] = await Promise.all([
        supabase.from("project_model_metrics").select("metric_name, metric_value").eq("project_model_id", productionModel.id),
        supabase.from("project_feature_importances").select("feature_name, importance_value").eq("project_model_id", productionModel.id).order("importance_value", { ascending: false }).limit(15),
      ]);
      bestModelMetrics = metricsRes.data || [];
      featureImportances = fiRes.data || [];
    }

    // ── Context flags ───────────────────────────────────────────────────────

    const contextFlags = {
      has_eda: (numericStats.length > 0 || categoricalStats.length > 0),
      has_inference: !!inference,
      has_target: !!(settings?.target_column || project.target_column),
      has_features: !!(settings?.feature_columns && Array.isArray(settings.feature_columns) && (settings.feature_columns as string[]).length > 0),
      has_model: trainedModels.length > 0,
      has_metrics: bestModelMetrics.length > 0,
      has_feature_importance: featureImportances.length > 0,
      has_predictions: predictionsCount > 0,
      has_dashboard_context: !!(aiCtx?.business || aiCtx?.predictions),
    };

    // ── Deterministic guardrails ────────────────────────────────────────────

    const targetColumn = settings?.target_column || project.target_column;
    const problemType = settings?.problem_type || project.problem_type;
    const totalRows = project.dataset_rows || 0;

    const targetGuardrails = runTargetGuardrails(targetColumn, problemType, numericStats, categoricalStats, totalRows);
    const modelGuardrails = runModelGuardrails(bestModelMetrics, problemType || "classification", featureImportances);

    // ── Build AI prompt for qualitative assessment ──────────────────────────

    const featureColumns = settings?.feature_columns && Array.isArray(settings.feature_columns)
      ? (settings.feature_columns as string[])
      : [];
    const excludedColumns = settings?.excluded_columns && Array.isArray(settings.excluded_columns)
      ? (settings.excluded_columns as string[])
      : [];

    // Build EDA summary
    let edaSummary = "";
    if (aiCtx?.eda?.summary) {
      edaSummary = aiCtx.eda.summary;
    } else if (edaInsights?.insights && Array.isArray(edaInsights.insights)) {
      edaSummary = (edaInsights.insights as string[]).slice(0, 5).join(". ");
    }

    // Build inference summary
    let inferenceSummary = "";
    if (inference) {
      const labels = Array.isArray(inference.suggested_problem_labels)
        ? (inference.suggested_problem_labels as { label: string }[])
            .filter(l => !(l.label || "").startsWith("__"))
            .map(l => l.label)
        : [];
      inferenceSummary = `Tipo: ${inference.problem_type}, Problemas: ${labels.join(", ")}, Confiança: ${inference.confidence}`;
      if (inference.narrative) inferenceSummary += `\nNarrativa: ${inference.narrative.substring(0, 300)}`;
    }

    // Build metrics text
    const metricsText = bestModelMetrics
      .map(m => `${m.metric_name}: ${m.metric_value.toFixed(4)}`)
      .join(", ");

    // Build FI text
    const fiText = featureImportances.slice(0, 10)
      .map(f => `${f.feature_name}: ${(f.importance_value * 100).toFixed(1)}%`)
      .join(", ");

    // Domain info
    const domainInfo = aiCtx?.targeting?.business_segment?.segment
      || (inference?.suggested_problem_labels as any[])?.find((l: any) => (l.label || "").startsWith("__industry:"))?.label?.replace("__industry:", "").split(":")[1]
      || "não identificado";

    const langMap: Record<string, string> = { pt: "Portuguese (Brazil)", en: "English", es: "Spanish" };

    const auditPrompt = `You are Lys, performing a CUMULATIVE PIPELINE AUDIT of a machine learning project.
Respond in ${langMap[language] || "Portuguese (Brazil)"}.

PROJECT STATE:
- Name: ${project.name}
- Problem type: ${problemType}
- Target: ${targetColumn || "NOT SET"}
- Dataset: ${totalRows} rows, ${project.dataset_columns || "?"} columns
- Business objective: ${project.business_objective || "not specified"}
- Domain: ${domainInfo}

EDA SUMMARY:
${edaSummary || "No EDA summary available"}
Numeric columns: ${numericStats.length}, Categorical columns: ${categoricalStats.length}

INFERENCE:
${inferenceSummary || "No inference performed"}

FEATURES:
Included: ${featureColumns.length > 0 ? featureColumns.slice(0, 15).join(", ") : "not configured"}
Excluded: ${excludedColumns.length > 0 ? excludedColumns.slice(0, 10).join(", ") : "none"}

MODEL:
Trained models: ${trainedModels.length} (${trainedModels.map(m => m.algorithm_name).join(", ")})
Production model: ${trainedModels.find(m => m.is_production)?.algorithm_name || "none selected"}
Metrics: ${metricsText || "none"}

FEATURE IMPORTANCE (top 10):
${fiText || "none"}

PREDICTIONS: ${predictionsCount} predictions generated

DETERMINISTIC GUARDRAILS ALREADY RUN:
Target valid: ${targetGuardrails.valid}
Target warnings: ${targetGuardrails.warnings.join("; ") || "none"}
Model adequate: ${modelGuardrails.adequate}
Model warnings: ${modelGuardrails.warnings.join("; ") || "none"}

CONTEXT FLAGS:
${Object.entries(contextFlags).map(([k, v]) => `${k}: ${v}`).join("\n")}

INSTRUCTIONS:
Generate a structured pipeline audit. You MUST respond with valid JSON matching this structure:
{
  "stages": {
    "eda": { "status": "ok|warning|error", "observations": ["..."] },
    "inference": { "status": "ok|warning|error", "observations": ["..."] },
    "target": { "status": "ok|warning|error", "observations": ["..."] },
    "model": { "status": "ok|warning|error", "observations": ["..."] },
    "dashboard": { "status": "ok|warning|error", "observations": ["..."] }
  },
  "incoherences": ["list of specific incoherences found"],
  "corrections": ["ordered list of corrections needed"],
  "executive_conclusion": "2-3 paragraph business conclusion"
}

RULES:
- If a stage has no data (context flag is false), mark it as "error" with observation explaining what's missing
- NEVER say everything is fine if guardrails found issues
- Include the deterministic guardrail warnings in the appropriate stage
- For model stage: assess if the model type matches the inferred problem
- For dashboard stage: ${isTrainingStage ? 'This project is still in the TRAINING phase. Predictions and dashboard are generated in LATER steps. Mark the dashboard stage as "warning" with observation that it is PENDING (not an error). Do NOT list missing predictions/dashboard as incoherences.' : isPredictionsStage ? 'This project is in the PREDICTIONS phase. Dashboard context will be available after scoring. If predictions exist, mark dashboard as "warning" (pending). Do NOT list missing dashboard as incoherence.' : 'assess if predictions exist and if dashboard context is coherent'}
- executive_conclusion MUST be in business language, explaining if the model can be used${isTrainingStage ? '. Note that predictions and dashboard will be available after scoring execution.' : isPredictionsStage ? '. Note that dashboard will be populated after predictions are generated.' : ' and if the dashboard is trustworthy'}
- Be honest and specific — never mask issues with generic phrases
- PIPELINE_STAGE: ${isTrainingStage ? 'TRAINING (do NOT penalize missing predictions or dashboard)' : isPredictionsStage ? 'PREDICTIONS (do NOT penalize missing dashboard)' : 'PRODUCTION (full audit)'}`;

    let aiAudit: any = null;

    if (lovableApiKey) {
      try {
        const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lovableApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: "You are a pipeline audit engine. Always respond with valid JSON only, no markdown." },
              { role: "user", content: auditPrompt },
            ],
            max_tokens: 2500,
            temperature: 0.3,
          }),
        });

        if (aiResponse.ok) {
          const aiData = await aiResponse.json();
          const text = aiData.choices?.[0]?.message?.content || "";
          // Extract JSON from response
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            aiAudit = JSON.parse(jsonMatch[0]);
          }
        } else {
          console.error(`[audit-pipeline] AI response error: ${aiResponse.status}`);
        }
      } catch (aiErr) {
        console.error("[audit-pipeline] AI audit error:", aiErr);
      }
    }

    // ── Build final report ──────────────────────────────────────────────────

    const dashboardFallback = isTrainingStage
      ? { status: "pending" as const, observations: ["PENDENTE: previsões e dashboard são gerados nas próximas etapas."] }
      : isPredictionsStage
      ? { status: "pending" as const, observations: ["PENDENTE: dashboard será populado após geração das previsões."] }
      : { status: (contextFlags.has_predictions ? "ok" : "warning") as "ok" | "warning" | "error", observations: contextFlags.has_predictions ? [] : ["Nenhuma previsão gerada ainda."] };

    const stages = aiAudit?.stages || {
      eda: { status: contextFlags.has_eda ? "ok" : "error", observations: contextFlags.has_eda ? [] : ["EDA não foi executada."] },
      inference: { status: contextFlags.has_inference ? "ok" : "error", observations: contextFlags.has_inference ? [] : ["Inferência de problema não foi executada."] },
      target: { status: targetGuardrails.valid ? "ok" : "error", observations: targetGuardrails.warnings },
      model: { status: modelGuardrails.adequate ? "ok" : "error", observations: modelGuardrails.warnings },
      dashboard: dashboardFallback,
    };

    // Override AI dashboard stage during training or predictions
    if (isTrainingStage && stages.dashboard) {
      stages.dashboard = { status: "pending", observations: ["PENDENTE: previsões e dashboard são gerados nas próximas etapas."] };
    } else if (isPredictionsStage && stages.dashboard) {
      stages.dashboard = { status: "pending", observations: ["PENDENTE: dashboard será populado após geração das previsões."] };
    }

    // Merge guardrail warnings into AI stages
    if (aiAudit?.stages?.target) {
      const existing = aiAudit.stages.target.observations || [];
      aiAudit.stages.target.observations = [...new Set([...targetGuardrails.warnings, ...existing])];
      if (!targetGuardrails.valid) aiAudit.stages.target.status = "error";
    }
    if (aiAudit?.stages?.model) {
      const existing = aiAudit.stages.model.observations || [];
      aiAudit.stages.model.observations = [...new Set([...modelGuardrails.warnings, ...existing])];
      if (!modelGuardrails.adequate) aiAudit.stages.model.status = "error";
    }

    // For training stage, exclude dashboard from overall coherence calculation
    // For predictions stage, also exclude dashboard (it's populated after scoring)
    const stagesToEvaluate = isTrainingStage
      ? Object.entries(stages).filter(([k]) => k !== "dashboard").map(([, v]) => v)
      : isPredictionsStage
      ? Object.entries(stages).filter(([k]) => k !== "dashboard").map(([, v]) => v)
      : Object.values(stages);
    const hasErrors = stagesToEvaluate.some((s: any) => s.status === "error");
    const hasWarnings = stagesToEvaluate.some((s: any) => s.status === "warning");

    // Filter out prediction/dashboard incoherences during training
    const filterTrainingIncoherences = (incs: string[]) => {
      if (!isTrainingStage && !isPredictionsStage) return incs;
      const blockedTerms = ["previsão", "previsões", "prediction", "dashboard", "scoring"];
      if (isTrainingStage) {
        return incs.filter(inc => !blockedTerms.some(t => inc.toLowerCase().includes(t)));
      }
      // predictions stage: only filter dashboard terms
      const dashTerms = ["dashboard"];
      return incs.filter(inc => !dashTerms.some(t => inc.toLowerCase().includes(t)));
    };

    const report: AuditReport = {
      overall_coherent: !hasErrors,
      confidence_level: hasErrors ? "low" : hasWarnings ? "medium" : "high",
      stages: aiAudit?.stages || stages,
      incoherences: filterTrainingIncoherences(aiAudit?.incoherences || [...targetGuardrails.warnings, ...modelGuardrails.warnings].filter(w => w.includes("INVÁLIDO") || w.includes("NÃO deve"))),
      corrections: filterTrainingIncoherences(aiAudit?.corrections || []),
      executive_conclusion: aiAudit?.executive_conclusion || "Auditoria parcial — a análise de IA não estava disponível. Verifique os guardrails determinísticos.",
      context_flags: contextFlags,
      disclaimer: "Estas conclusões são baseadas em evidência estatística e estrutural do projeto, não em suposições.",
    };

    console.log(`[audit-pipeline] Audit complete: coherent=${report.overall_coherent}, confidence=${report.confidence_level}`);

    return new Response(JSON.stringify({ success: true, report }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[audit-pipeline] Error:", error);
    return new Response(JSON.stringify({ error: "Erro interno na auditoria" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
