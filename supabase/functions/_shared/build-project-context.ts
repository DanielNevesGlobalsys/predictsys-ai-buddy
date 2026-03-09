/**
 * build-project-context.ts
 * 
 * Unified context builder for all Lys AI calls.
 * Consolidates SSOT data into a single structured payload that every
 * edge function can use, ensuring narrative consistency across the pipeline.
 */

export interface LysProjectContext {
  // Identity
  project_name: string;
  industry: string | null;
  business_objective: string | null;

  // Intent
  intent_contract: {
    problem_type: string;
    target_column: string | null;
    entity_key: string | null;
    objective: string | null;
    guardrails: Record<string, any>;
  } | null;

  // Dataset
  dataset_summary: {
    total_rows: number;
    total_columns: number;
    source_type: string | null;
    entity_key: string | null;
    time_anchor: string | null;
  };

  // EDA
  eda_summary: {
    numeric_columns: { name: string; mean: string; std: string; missing_pct: string; distinct: number }[];
    categorical_columns: { name: string; distinct: number; top_category: string | null; top_pct: string | null }[];
    eda_profile: Record<string, any> | null;
    warnings: string[];
  };

  // Target
  target_definition: {
    target_column: string | null;
    problem_type: string | null;
    selected_features: string[];
    excluded_features: string[];
    target_quality: Record<string, any> | null;
  };

  // Model
  model_summary: {
    model_type: string | null;
    algorithm_name: string | null;
    metrics: Record<string, number>;
    feature_importance: { feature: string; importance: number }[];
    confidence_level: string | null;
    limitations: string[];
  } | null;

  // Scoring
  scoring_summary: {
    total_predictions: number;
    high_risk_count: number;
    financial_impact: number;
    coverage_pct: number;
  } | null;

  // Previous Lys insights (memory)
  previous_insights: {
    lys_synthesis_narrative: string | null;
    executive_summary: string | null;
    eda_insight: string | null;
    training_insight: string | null;
  };

  // TDE candidates
  tde_candidates: {
    status_candidates: any[];
    value_candidates: any[];
    event_candidates: any[];
    dataset_format: string | null;
  };
}

export async function buildProjectContext(
  serviceClient: any,
  projectId: string
): Promise<LysProjectContext> {
  const [
    settingsRes,
    projectRes,
    selectionRes,
    intentRes,
    aiCtxRes,
    numStatsRes,
    catStatsRes,
    modelsRes,
    featureImpRes,
    predStateRes,
    insightsRes,
  ] = await Promise.all([
    serviceClient.from("project_settings").select("*").eq("project_id", projectId).maybeSingle(),
    serviceClient.from("projects").select("name, problem_type, target_column, business_objective, dataset_rows, dataset_columns").eq("id", projectId).single(),
    serviceClient.from("project_model_selection").select("*").eq("project_id", projectId).maybeSingle(),
    serviceClient.from("project_modeling_contracts").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    serviceClient.from("project_ai_context").select("context").eq("project_id", projectId).maybeSingle(),
    serviceClient.from("project_numeric_stats").select("column_name, mean_value, std_value, null_count, distinct_count").eq("project_id", projectId).limit(40),
    serviceClient.from("project_categorical_stats").select("column_name, distinct_count, top_categories").eq("project_id", projectId).limit(25),
    serviceClient.from("project_models").select("id, algorithm_name, status, is_production, hyperparameters").eq("project_id", projectId).eq("is_production", true).limit(1),
    serviceClient.from("project_feature_importances").select("feature_name, importance_value, project_model_id").eq("project_id", projectId).order("importance_value", { ascending: false }).limit(15),
    serviceClient.from("project_prediction_state").select("predictions_count, coverage_pct, latest_batch_id").eq("project_id", projectId).maybeSingle(),
    serviceClient.from("project_model_insights").select("insight_type, insights").eq("project_id", projectId).order("created_at", { ascending: false }).limit(10),
  ]);

  const settings = (settingsRes.data || {}) as Record<string, any>;
  const project = (projectRes.data || {}) as Record<string, any>;
  const selection = (selectionRes.data || {}) as Record<string, any>;
  const intentContract = intentRes.data as Record<string, any> | null;
  const aiCtx = (aiCtxRes.data?.context || {}) as Record<string, any>;
  const numStats = numStatsRes.data || [];
  const catStats = catStatsRes.data || [];
  const productionModel = modelsRes.data?.[0] as Record<string, any> | null;
  const featureImportances = featureImpRes.data || [];
  const predState = predStateRes.data as Record<string, any> | null;
  const allInsights = insightsRes.data || [];

  const totalRows = settings.ingestion_rows_detected || project.dataset_rows || 0;

  // Build numeric summary
  const numericColumns = numStats.map((s: any) => ({
    name: s.column_name,
    mean: s.mean_value?.toFixed(2) || "0",
    std: s.std_value?.toFixed(2) || "0",
    missing_pct: s.null_count > 0 && totalRows
      ? ((s.null_count / totalRows) * 100).toFixed(1) + "%"
      : "0%",
    distinct: s.distinct_count || 0,
  }));

  // Build categorical summary
  const categoricalColumns = catStats.map((s: any) => ({
    name: s.column_name,
    distinct: s.distinct_count || 0,
    top_category: s.top_categories?.[0]?.category || null,
    top_pct: s.top_categories?.[0]?.count && totalRows
      ? ((s.top_categories[0].count / totalRows) * 100).toFixed(1) + "%"
      : null,
  }));

  // Build model metrics from production model
  let modelSummary: LysProjectContext["model_summary"] = null;
  if (productionModel) {
    // Get metrics for this model
    const { data: metricsData } = await serviceClient
      .from("project_model_metrics")
      .select("metric_name, metric_value")
      .eq("project_model_id", productionModel.id);

    const metricsMap: Record<string, number> = {};
    (metricsData || []).forEach((m: any) => {
      metricsMap[m.metric_name] = m.metric_value;
    });

    modelSummary = {
      model_type: productionModel.algorithm_name || null,
      algorithm_name: productionModel.algorithm_name || null,
      metrics: metricsMap,
      feature_importance: featureImportances.map((f: any) => ({
        feature: f.feature_name,
        importance: f.importance_value,
      })),
      confidence_level: aiCtx.training?.confidence_level || null,
      limitations: aiCtx.training?.limitations || [],
    };
  }

  // Scoring summary
  let scoringSummary: LysProjectContext["scoring_summary"] = null;
  if (predState?.predictions_count) {
    // Get high-risk count from predictions
    const { count } = await serviceClient
      .from("predictions")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("is_latest", true)
      .gte("probability_event", 0.7);

    scoringSummary = {
      total_predictions: predState.predictions_count || 0,
      high_risk_count: count || 0,
      financial_impact: 0, // computed at dashboard level
      coverage_pct: predState.coverage_pct || 0,
    };
  }

  // Previous insights (memory)
  const findInsight = (type: string) => {
    const found = allInsights.find((i: any) => i.insight_type === type);
    if (!found?.insights) return null;
    if (typeof found.insights === "string") return found.insights.substring(0, 500);
    if (Array.isArray(found.insights)) {
      return found.insights.map((i: any) => typeof i === "string" ? i : i.content || i.text || "").join(" ").substring(0, 500);
    }
    return null;
  };

  const tdeProfile = aiCtx.tde_profile || {};
  const tdeCandidates = tdeProfile.candidates || {};

  return {
    project_name: project.name || "Projeto",
    industry: settings.industry || null,
    business_objective: settings.objective || project.business_objective || null,

    intent_contract: intentContract ? {
      problem_type: intentContract.problem_type || selection.problem_type || project.problem_type,
      target_column: intentContract.target_column || selection.target_column || null,
      entity_key: intentContract.entity_key || settings.entity_key || null,
      objective: intentContract.objective || settings.objective || null,
      guardrails: intentContract.guardrails || settings.business_intent_contract?.guardrails || {},
    } : (settings.business_intent_contract ? {
      problem_type: settings.business_intent_contract.problem_type || selection.problem_type || project.problem_type,
      target_column: selection.target_column || project.target_column || null,
      entity_key: settings.entity_key || null,
      objective: settings.objective || null,
      guardrails: settings.business_intent_contract.guardrails || {},
    } : null),

    dataset_summary: {
      total_rows: totalRows,
      total_columns: settings.ingestion_cols_detected || project.dataset_columns || 0,
      source_type: settings.ingestion_source_type || null,
      entity_key: settings.entity_key || null,
      time_anchor: settings.time_anchor_column || null,
    },

    eda_summary: {
      numeric_columns: numericColumns,
      categorical_columns: categoricalColumns,
      eda_profile: settings.eda_profile_json || null,
      warnings: aiCtx.eda?.warnings || [],
    },

    target_definition: {
      target_column: selection.target_column || settings.target_column || project.target_column || null,
      problem_type: selection.problem_type || project.problem_type || null,
      selected_features: Array.isArray(selection.selected_features) ? selection.selected_features : [],
      excluded_features: Array.isArray(selection.excluded_features) ? selection.excluded_features : [],
      target_quality: aiCtx.targeting?.target_quality || null,
    },

    model_summary: modelSummary,

    scoring_summary: scoringSummary,

    previous_insights: {
      lys_synthesis_narrative: settings.lys_insight_text || null,
      executive_summary: aiCtx.storyline?.executive_summary || null,
      eda_insight: findInsight("eda"),
      training_insight: findInsight("training"),
    },

    tde_candidates: {
      status_candidates: (tdeCandidates.status_candidates || []).slice(0, 5),
      value_candidates: (tdeCandidates.value_candidates || []).slice(0, 5),
      event_candidates: (tdeCandidates.event_candidates || []).slice(0, 5),
      dataset_format: tdeProfile.dataset_format || null,
    },
  };
}

/**
 * Serialize context to a compact string for prompts.
 * Removes null values and limits text length.
 */
export function contextToPromptBlock(ctx: LysProjectContext): string {
  const clean = JSON.parse(JSON.stringify(ctx, (_, v) => v === null ? undefined : v));
  return JSON.stringify(clean, null, 1);
}
