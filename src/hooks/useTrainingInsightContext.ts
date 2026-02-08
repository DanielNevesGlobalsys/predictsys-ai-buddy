import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface TrainingProjectState {
  eda_summary: string | null;
  business_inference: {
    domain: string | null;
    problem_type: string | null;
    problem_statement: string | null;
    industry_label: string | null;
    industry_confidence: number | null;
  } | null;
  target: {
    column: string | null;
    type: string | null;
    reason: string | null;
  } | null;
  features: {
    included: string[];
    excluded: string[];
    reasoning: string | null;
  } | null;
}

export interface TrainingResult {
  algorithm: string;
  metrics: Record<string, number>;
  validation_info: string | null;
}

export interface FeatureImportanceItem {
  feature_name: string;
  importance_value: number;
}

export interface ContextFlags {
  used_eda_summary: boolean;
  used_business_inference: boolean;
  used_selected_target: boolean;
  used_selected_features: boolean;
  used_model_metrics: boolean;
  used_feature_importance: boolean;
}

export interface PreflightReport {
  target_valid: boolean;
  target_issues: string[];
  target_suggestions: string[];
  features_blocked: string[];
  features_block_reasons: Record<string, string>;
  warnings: string[];
}

export interface ModelQualityInfo {
  model_quality_flag: string | null;
  baseline_metrics: Record<string, number> | null;
  predictions_count: number | null;
  preflight_report: PreflightReport | null;
}

export interface DebugInfo {
  project_state_version: string;
  context_flags: ContextFlags;
  missing_fields: string[];
  fallback_reason: string | null;
  payload_preview: Record<string, any>;
  quality_info: ModelQualityInfo;
}

export function useTrainingInsightContext(projectId: string | undefined) {
  const [projectState, setProjectState] = useState<TrainingProjectState | null>(null);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const gatherContext = useCallback(async (
    modelId: string | undefined,
    modelName: string | undefined,
    problemType: string,
    featureImportances: FeatureImportanceItem[],
    modelMetrics: { metric_name: string; metric_value: number }[]
  ): Promise<{
    projectState: TrainingProjectState;
    trainingResult: TrainingResult;
    featureImportance: FeatureImportanceItem[];
    debugInfo: DebugInfo;
  } | null> => {
    if (!projectId) return null;
    setLoading(true);

    try {
      // Fetch all context in parallel
      const [aiCtxRes, inferenceRes, settingsRes, edaInsightsRes, modelRes, predictionsCountRes] = await Promise.all([
        supabase
          .from("project_ai_context")
          .select("context, last_updated_at")
          .eq("project_id", projectId)
          .maybeSingle(),
        supabase
          .from("project_problem_inference")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("project_settings")
          .select("target_column, problem_type, feature_columns, excluded_columns")
          .eq("project_id", projectId)
          .maybeSingle(),
        supabase
          .from("project_eda_insights")
          .select("insights")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        modelId
          ? supabase
              .from("project_models")
              .select("hyperparameters")
              .eq("id", modelId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        supabase
          .from("predictions")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("is_latest", true),
      ]);

      const aiCtx = aiCtxRes.data?.context as Record<string, any> | null;
      const inference = inferenceRes.data;
      const settings = settingsRes.data;
      const edaInsights = edaInsightsRes.data;

      // Extract model quality info from hyperparameters
      const hp = modelRes.data?.hyperparameters as Record<string, any> | null;
      const qualityInfo: ModelQualityInfo = {
        model_quality_flag: hp?.model_quality_flag || null,
        baseline_metrics: hp?.baseline_metrics || null,
        predictions_count: predictionsCountRes.count ?? null,
        preflight_report: hp?.preflight_report || null,
      };

      // Build EDA summary
      let edaSummary: string | null = null;
      if (aiCtx?.eda?.summary) {
        edaSummary = aiCtx.eda.summary;
      } else if (edaInsights?.insights && Array.isArray(edaInsights.insights)) {
        edaSummary = (edaInsights.insights as string[]).slice(0, 5).join(". ");
      }

      // Build business inference
      let businessInference: TrainingProjectState["business_inference"] = null;
      if (inference) {
        const labels = Array.isArray(inference.suggested_problem_labels) 
          ? inference.suggested_problem_labels as { label: string; relevance?: number }[]
          : [];
        const industryLabel = labels.find(l => (l.label || "").startsWith("__industry:"));
        let industry_label: string | null = null;
        let industry_confidence: number | null = null;

        if (industryLabel) {
          const parts = industryLabel.label.replace("__industry:", "").split(":");
          industry_label = parts[1] || parts[0] || null;
          industry_confidence = parseFloat(parts[2]) || null;
        }

        const problemLabels = labels
          .filter(l => !(l.label || "").startsWith("__industry:"))
          .map(l => l.label);

        businessInference = {
          domain: industry_label,
          problem_type: inference.problem_type,
          problem_statement: problemLabels.length > 0 ? problemLabels.join(", ") : null,
          industry_label,
          industry_confidence,
        };
      } else if (aiCtx?.targeting?.business_segment) {
        businessInference = {
          domain: aiCtx.targeting.business_segment.segment || null,
          problem_type: aiCtx.targeting.selected_problem || problemType,
          problem_statement: aiCtx.targeting.insight_text || null,
          industry_label: aiCtx.targeting.business_segment.segment || null,
          industry_confidence: null,
        };
      }

      // Build target info
      let targetInfo: TrainingProjectState["target"] = null;
      if (settings?.target_column) {
        const suggestedTarget = inference?.suggested_targets && Array.isArray(inference.suggested_targets)
          ? (inference.suggested_targets as any[]).find((t: any) => t.column === settings.target_column)
          : null;

        targetInfo = {
          column: settings.target_column,
          type: settings.problem_type || problemType,
          reason: suggestedTarget?.why_this_target || suggestedTarget?.business_summary || null,
        };
      }

      // Build features info
      let featuresInfo: TrainingProjectState["features"] = null;
      const included = settings?.feature_columns && Array.isArray(settings.feature_columns) 
        ? settings.feature_columns as string[] 
        : [];
      const excluded = settings?.excluded_columns && Array.isArray(settings.excluded_columns) 
        ? settings.excluded_columns as string[] 
        : [];

      if (included.length > 0 || excluded.length > 0) {
        featuresInfo = {
          included,
          excluded,
          reasoning: aiCtx?.targeting?.justification || null,
        };
      }

      const state: TrainingProjectState = {
        eda_summary: edaSummary,
        business_inference: businessInference,
        target: targetInfo,
        features: featuresInfo,
      };

      // Build training result
      const metricsMap: Record<string, number> = {};
      modelMetrics.forEach(m => { metricsMap[m.metric_name] = m.metric_value; });

      const trainingResult: TrainingResult = {
        algorithm: modelName || "unknown",
        metrics: metricsMap,
        validation_info: null,
      };

      // Build debug info
      const missingFields: string[] = [];
      if (!edaSummary) missingFields.push("eda_summary");
      if (!businessInference) missingFields.push("business_inference");
      if (!businessInference?.domain) missingFields.push("business_inference.domain");
      if (!businessInference?.problem_statement) missingFields.push("business_inference.problem_statement");
      if (!targetInfo) missingFields.push("target");
      if (!targetInfo?.reason) missingFields.push("target.reason");
      if (!featuresInfo || featuresInfo.included.length === 0) missingFields.push("features.included");
      if (Object.keys(metricsMap).length === 0) missingFields.push("training_result.metrics");
      if (featureImportances.length === 0) missingFields.push("feature_importance");

      const contextFlags: ContextFlags = {
        used_eda_summary: !!edaSummary,
        used_business_inference: !!businessInference?.problem_statement,
        used_selected_target: !!targetInfo?.column,
        used_selected_features: !!(featuresInfo && featuresInfo.included.length > 0),
        used_model_metrics: Object.keys(metricsMap).length > 0,
        used_feature_importance: featureImportances.length > 0,
      };

      let fallbackReason: string | null = null;
      const criticalMissing = missingFields.filter(f => 
        ["eda_summary", "business_inference", "target"].includes(f)
      );
      if (criticalMissing.length > 0) {
        fallbackReason = `Contexto incompleto: ${criticalMissing.join(", ")} ausente(s). Gere o EDA e configure o target primeiro.`;
      }

      const debug: DebugInfo = {
        project_state_version: aiCtxRes.data?.last_updated_at || new Date().toISOString(),
        context_flags: contextFlags,
        missing_fields: missingFields,
        fallback_reason: fallbackReason,
        payload_preview: {
          has_eda: !!edaSummary,
          has_inference: !!businessInference,
          has_target: !!targetInfo,
          features_count: featuresInfo?.included.length || 0,
          metrics_count: Object.keys(metricsMap).length,
          fi_count: featureImportances.length,
        },
        quality_info: qualityInfo,
      };

      setProjectState(state);
      setDebugInfo(debug);

      return { projectState: state, trainingResult, featureImportance: featureImportances, debugInfo: debug };
    } catch (err) {
      console.error("[useTrainingInsightContext] Error gathering context:", err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  return { projectState, debugInfo, loading, gatherContext };
}
