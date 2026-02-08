import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { 
  Loader2, 
  BarChart3, 
  Sparkles, 
  RefreshCw, 
  TrendingUp,
  Target,
  AlertTriangle,
  CheckCircle2,
  Building2,
  Crosshair
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useTrainingInsightContext, type FeatureImportanceItem, type DebugInfo } from "@/hooks/useTrainingInsightContext";
import DebugLysPanel from "./DebugLysPanel";

interface ModelResult {
  id: string;
  algorithm_name: string;
  status: string;
  is_production: boolean;
  metrics: { metric_name: string; metric_value: number }[];
}

interface ParsedInsights {
  businessProblem: string;
  targetExplanation: string;
  modelQuality: string;
  featureInfluence: string;
  risks: string[];
  recommendations: string[];
}

interface UnifiedModelInsightsProps {
  projectId: string;
  modelId?: string;
  modelName?: string;
  problemType: string;
  models: ModelResult[];
  bestModelId?: string;
  datasetRows?: number;
  targetColumn?: string;
}

const UnifiedModelInsights = ({
  projectId,
  modelId,
  modelName,
  problemType,
  models,
  bestModelId,
  datasetRows,
  targetColumn,
}: UnifiedModelInsightsProps) => {
  const { t, i18n } = useTranslation();
  const [featureImportances, setFeatureImportances] = useState<FeatureImportanceItem[]>([]);
  const [parsedInsights, setParsedInsights] = useState<ParsedInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatingInsights, setGeneratingInsights] = useState(false);
  const { debugInfo, gatherContext } = useTrainingInsightContext(projectId);

  useEffect(() => {
    if (modelId) {
      loadFeatureImportances();
      loadSavedInsights();
    }
  }, [modelId, i18n.language]);

  const loadFeatureImportances = async () => {
    if (!modelId) return;
    
    setLoading(true);
    const { data, error } = await supabase
      .from("project_feature_importances")
      .select("feature_name, importance_value")
      .eq("project_model_id", modelId)
      .order("importance_value", { ascending: false })
      .limit(10);

    if (error) {
      console.error("Error loading feature importances:", error);
    } else if (data) {
      setFeatureImportances(data);
    }
    setLoading(false);
  };

  const loadSavedInsights = async () => {
    if (!modelId) return;

    try {
      const { data, error } = await supabase
        .from("project_model_insights")
        .select("shap_insights")
        .eq("project_id", projectId)
        .eq("model_id", modelId)
        .eq("language", i18n.language)
        .eq("insight_type", "unified_cumulative")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error("Error loading saved insights:", error);
        return;
      }

      if (data?.shap_insights) {
        try {
          const raw = typeof data.shap_insights === 'string' 
            ? JSON.parse(data.shap_insights) 
            : data.shap_insights;
          
          const parsed: ParsedInsights = {
            businessProblem: raw?.businessProblem || raw?.summary || "",
            targetExplanation: raw?.targetExplanation || "",
            modelQuality: raw?.modelQuality || "",
            featureInfluence: raw?.featureInfluence || raw?.featureImportance || "",
            risks: Array.isArray(raw?.risks) 
              ? raw.risks.map((r: unknown) => typeof r === 'string' ? r : String(r))
              : [],
            recommendations: Array.isArray(raw?.recommendations)
              ? raw.recommendations.map((r: unknown) => typeof r === 'string' ? r : String(r))
              : [],
          };
          setParsedInsights(parsed);
        } catch (e) {
          console.error("Error parsing saved insights:", e);
          // Try legacy format
          loadLegacySavedInsights();
        }
      } else {
        // Try legacy format
        loadLegacySavedInsights();
      }
    } catch (e) {
      console.error("Error in loadSavedInsights:", e);
    }
  };

  const loadLegacySavedInsights = async () => {
    if (!modelId) return;
    const { data } = await supabase
      .from("project_model_insights")
      .select("shap_insights")
      .eq("project_id", projectId)
      .eq("model_id", modelId)
      .eq("language", i18n.language)
      .eq("insight_type", "unified_cards")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.shap_insights) {
      try {
        const raw = typeof data.shap_insights === 'string' 
          ? JSON.parse(data.shap_insights) 
          : data.shap_insights;
        setParsedInsights({
          businessProblem: raw?.summary || "",
          targetExplanation: "",
          modelQuality: "",
          featureInfluence: raw?.featureImportance || "",
          risks: Array.isArray(raw?.risks) ? raw.risks.map(String) : [],
          recommendations: Array.isArray(raw?.recommendations) ? raw.recommendations.map(String) : [],
        });
      } catch { /* ignore */ }
    }
  };

  const handleRefreshDebug = async () => {
    if (!modelId) return;
    const currentModel = models.find(m => m.id === modelId);
    await gatherContext(modelId, modelName, problemType, featureImportances, currentModel?.metrics || []);
  };

  const generateInsights = async () => {
    if (!modelId) {
      toast.error(t("training.selectModelFirst"));
      return;
    }
    
    if (featureImportances.length === 0) {
      toast.error(t("training.noFeatureImportances"));
      return;
    }

    setGeneratingInsights(true);
    
    try {
      const currentModel = models.find(m => m.id === modelId);
      const currentMetrics = currentModel?.metrics || [];

      // Gather cumulative context
      const ctx = await gatherContext(modelId, modelName, problemType, featureImportances, currentMetrics);

      if (ctx?.debugInfo.fallback_reason) {
        console.warn("[UnifiedModelInsights] Fallback detected:", ctx.debugInfo.fallback_reason);
      }

      // Build metrics text
      const metricsText = currentMetrics
        .filter(m => ["AUC", "F1", "Precision", "Recall", "Accuracy", "R²", "MAE", "RMSE"].includes(m.metric_name))
        .map(m => `${m.metric_name}: ${m.metric_name === "MAE" || m.metric_name === "RMSE" 
          ? m.metric_value.toFixed(4) 
          : (m.metric_value * 100).toFixed(1) + "%"}`)
        .join(", ");

      // Build feature importances text
      const topFeatures = featureImportances.slice(0, 10);
      const featureList = topFeatures.map(f => 
        `- ${f.feature_name}: ${(f.importance_value * 100).toFixed(1)}%`
      ).join("\n");

      // Check for ID columns
      const idColumns = topFeatures.filter(f => 
        f.feature_name.toLowerCase().includes("id") || 
        f.feature_name.toLowerCase() === "id"
      );

      const lang = i18n.language === 'pt' ? 'Portuguese (Brazil)' : i18n.language === 'es' ? 'Spanish' : 'English';
      
      // Build cumulative context block
      const ps = ctx?.projectState;
      let contextBlock = "";
      if (ps?.business_inference?.problem_statement) {
        contextBlock += `\nInferred Business Problem: ${ps.business_inference.problem_statement}`;
        if (ps.business_inference.domain) contextBlock += ` (Domain: ${ps.business_inference.domain})`;
      }
      if (ps?.eda_summary) {
        contextBlock += `\nEDA Summary: ${ps.eda_summary.substring(0, 500)}`;
      }
      if (ps?.target?.column) {
        contextBlock += `\nTarget: ${ps.target.column} (type: ${ps.target.type || problemType})`;
        if (ps.target.reason) contextBlock += ` — Reason: ${ps.target.reason}`;
      }
      if (ps?.features) {
        contextBlock += `\nIncluded features: ${ps.features.included.length} columns`;
        if (ps.features.excluded.length > 0) {
          contextBlock += ` | Excluded: ${ps.features.excluded.slice(0, 5).join(", ")}${ps.features.excluded.length > 5 ? "..." : ""}`;
        }
        if (ps.features.reasoning) contextBlock += `\nFeature reasoning: ${ps.features.reasoning.substring(0, 200)}`;
      }

      const isRegression = problemType === "regression";

      const systemPrompt = `You are Lys, an AI business analyst that connects ML results to real business context.
Respond in ${lang}.

CRITICAL RULES:
- NEVER use generic phrases like "test other algorithms" or "try more data" as the only recommendation
- ALWAYS connect insights to the specific business problem being solved
- DO NOT return JSON. Use plain text with the section headers below.
- When explaining metrics, translate them to business impact (e.g., "the model correctly identifies 87% of at-risk customers")
- Reference the specific domain, target, and features in your analysis

Structure your response with these EXACT section headers:

===PROBLEMA DE NEGÓCIO INFERIDO===
${ps?.business_inference?.problem_statement 
  ? "Explain the specific business problem being addressed, using the inferred domain and problem statement."
  : "State that no specific business inference was available and describe what the model appears to predict based on the target variable."}

===O QUE ESTAMOS PREVENDO===
Explain what the target variable represents, why it was chosen, and what kind of predictions the model makes (probability of event, estimated value, etc.)

===QUALIDADE DO MODELO===
${isRegression 
  ? "Explain R², MAE, and RMSE in business terms (e.g., 'average prediction error of X units'). Rate quality as strong/medium/weak."
  : "Explain AUC, F1, Precision, Recall in business terms (e.g., 'correctly identifies X% of at-risk cases'). Rate quality as strong/medium/weak."}

===O QUE MAIS INFLUENCIA===
For each of the top 5 features, explain WHY it influences the prediction in business terms. Connect each feature to the specific problem.

===RISCOS===
• Risk 1 (specific to this model/data, not generic)
• Risk 2
• Risk 3

===AÇÕES RECOMENDADAS===
• Action 1 (business-specific, connected to the problem)
• Action 2
• Action 3`;

      const prompt = `Analyze this ML model with the following cumulative project context:

${contextBlock || "No prior context available."}

Model: "${modelName}" (${problemType})
Target: ${targetColumn || "not specified"}
Dataset: ${datasetRows || "unknown"} rows
Metrics: ${metricsText || "not available"}

Top feature importances:
${featureList}

${idColumns.length > 0 ? `⚠️ WARNING: ID columns in top features: ${idColumns.map(f => f.feature_name).join(", ")}. This indicates overfitting.` : ""}

Provide your analysis following the exact section structure. Be specific to THIS problem and THESE features.`;

      const { data, error } = await supabase.functions.invoke("global-chat", {
        body: {
          message: prompt,
          systemPrompt,
        },
      });

      if (error) {
        console.error("Edge function error:", error);
        throw new Error(error.message || t("training.insightsError"));
      }

      const responseText = data?.response || data?.text || "";
      
      // Parse the response
      const parsed = parseStructuredResponse(responseText, topFeatures, idColumns, isRegression);
      setParsedInsights(parsed);

      // Save insights
      try {
        await (supabase.from("project_model_insights") as any).insert({
          project_id: projectId,
          model_id: modelId,
          language: i18n.language,
          insight_type: "unified_cumulative",
          shap_insights: JSON.stringify(parsed),
          insights: [],
        });
      } catch (saveError) {
        console.error("Error saving insights:", saveError);
      }

      // Also update AI context with training insights
      try {
        await supabase.functions.invoke("append-project-context", {
          body: {
            project_id: projectId,
            stage: "training",
            payload: {
              model_type: modelName,
              metrics: ctx?.trainingResult.metrics || {},
              confidence_level: getConfidenceLevel(currentMetrics, isRegression),
              limitations: parsed.risks,
              insights_generated: true,
              cumulative_context_used: !ctx?.debugInfo.fallback_reason,
            },
          },
        });
      } catch { /* non-critical */ }

      toast.success(t("training.insightsGenerated"));
    } catch (error) {
      console.error("Error generating insights:", error);
      toast.error(t("training.insightsError"));
      setParsedInsights({
        businessProblem: t("training.insightsErrorMessage"),
        targetExplanation: "",
        modelQuality: "",
        featureInfluence: "",
        risks: [],
        recommendations: [t("training.tryAgainLater")]
      });
    } finally {
      setGeneratingInsights(false);
    }
  };

  const maxImportance = featureImportances.length > 0 
    ? Math.max(...featureImportances.map(f => f.importance_value))
    : 1;

  if (!modelId) {
    return (
      <Card className="p-6">
        <div className="text-center text-muted-foreground py-8">
          <Target className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>{t("training.selectModelForInterpretability")}</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Debug Panel */}
      <DebugLysPanel debugInfo={debugInfo} onRefresh={handleRefreshDebug} loading={loading} />

      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-secondary/10 rounded-lg flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-secondary" />
          </div>
          <div>
            <h3 className="font-semibold text-lg">{t("training.unifiedInsightsTitle")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("training.unifiedInsightsSubtitle")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {modelName && (
            <span className="text-sm text-muted-foreground bg-muted px-3 py-1.5 rounded-full font-medium">
              {modelName}
            </span>
          )}
          <Button
            variant={parsedInsights ? "outline" : "default"}
            size="sm"
            onClick={generateInsights}
            disabled={generatingInsights || featureImportances.length === 0}
            className={!parsedInsights ? "bg-gradient-primary hover:shadow-hover" : ""}
          >
            {generatingInsights ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                {t("training.generatingInsights")}
              </>
            ) : parsedInsights ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                {t("training.regenerate")}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                {t("training.generateInsights")}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Feature Importance Chart */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium mb-4">
          <BarChart3 className="w-4 h-4 text-primary" />
          {t("training.featureImportance")}
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : featureImportances.length > 0 ? (
          <div className="grid gap-2.5">
            {featureImportances.slice(0, 5).map((feature, index) => {
              const isIdColumn = feature.feature_name.toLowerCase().includes("id");
              return (
                <div key={feature.feature_name} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className={`font-medium truncate max-w-[200px] flex items-center gap-1.5 ${isIdColumn ? 'text-destructive' : ''}`}>
                      {index + 1}. {feature.feature_name}
                      {isIdColumn && <AlertTriangle className="w-3 h-3" />}
                    </span>
                    <span className="text-muted-foreground">
                      {(feature.importance_value * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all ${isIdColumn ? 'bg-destructive/60' : 'bg-gradient-to-r from-primary to-primary/60'}`}
                      style={{ width: `${(feature.importance_value / maxImportance) * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-4 text-muted-foreground">
            <p className="text-sm">{t("training.noFeatureImportances")}</p>
          </div>
        )}
      </Card>

      {/* Insights Cards Grid - 4 mandatory blocks + risks/recommendations */}
      {parsedInsights ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Block 1 - Business Problem */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-chart-1/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <Building2 className="w-4 h-4 text-chart-1" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm mb-2">{t("training.insightsBusinessProblem")}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {parsedInsights.businessProblem || t("training.insightsBusinessProblemFallback", { defaultValue: "Clique em 'Gerar Insights' para que a Lys analise o contexto de negócio com base no EDA, target e métricas do modelo." })}
                </p>
              </div>
            </div>
          </Card>

          {/* Block 2 - Target Explanation */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-chart-2/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <Crosshair className="w-4 h-4 text-chart-2" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm mb-2">{t("training.insightsTarget")}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {parsedInsights.targetExplanation || (targetColumn 
                    ? t("training.insightsTargetFallback", { defaultValue: `Target: ${targetColumn} (${problemType}). Gere insights para uma análise detalhada da variável alvo.`, target: targetColumn, type: problemType })
                    : t("training.insightsTargetMissing", { defaultValue: "Nenhuma variável alvo definida. Configure o target na etapa anterior." })
                  )}
                </p>
              </div>
            </div>
          </Card>

          {/* Block 3 - Model Quality */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <TrendingUp className="w-4 h-4 text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm mb-2">{t("training.insightsModelQuality")}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {parsedInsights.modelQuality || (() => {
                    const currentModel = models.find(m => m.id === modelId);
                    const metricsStr = currentModel?.metrics
                      ?.filter(m => ["AUC", "F1", "R²", "MAE", "RMSE"].includes(m.metric_name))
                      .map(m => `${m.metric_name}: ${m.metric_value.toFixed(4)}`)
                      .join(" | ");
                    return metricsStr 
                      ? t("training.insightsModelQualityFallback", { defaultValue: `Métricas: ${metricsStr}. Gere insights para uma avaliação completa da qualidade.`, metrics: metricsStr })
                      : t("training.insightsModelQualityMissing", { defaultValue: "Métricas não disponíveis. O modelo pode não ter sido treinado corretamente." });
                  })()}
                </p>
              </div>
            </div>
          </Card>

          {/* Block 4 - Feature Influence */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-chart-4/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <BarChart3 className="w-4 h-4 text-chart-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm mb-2">{t("training.insightsFeatureInfluence")}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {parsedInsights.featureInfluence || (featureImportances.length > 0 
                    ? featureImportances.slice(0, 5).map(f => `${f.feature_name} (${(f.importance_value * 100).toFixed(1)}%)`).join(", ")
                    : t("training.insightsFeatureInfluenceMissing", { defaultValue: "Nenhuma importância de variável registrada. Verifique se o treinamento concluiu com sucesso." })
                  )}
                </p>
              </div>
            </div>
          </Card>

          {/* Risks */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-destructive/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-4 h-4 text-destructive" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm mb-2">{t("training.insightsRisks")}</h4>
                <ul className="space-y-1.5">
                  {Array.isArray(parsedInsights.risks) && parsedInsights.risks.length > 0 ? (
                    parsedInsights.risks.map((risk, idx) => (
                      <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                        <span className="text-destructive mt-1.5 flex-shrink-0">•</span>
                        <span>{risk}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-sm text-muted-foreground">{t("training.noRisksIdentified")}</li>
                  )}
                </ul>
              </div>
            </div>
          </Card>

          {/* Recommendations */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-chart-3/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <CheckCircle2 className="w-4 h-4 text-chart-3" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm mb-2">{t("training.insightsRecommendations")}</h4>
                <ul className="space-y-1.5">
                  {Array.isArray(parsedInsights.recommendations) && parsedInsights.recommendations.length > 0 ? (
                    parsedInsights.recommendations.map((rec, idx) => (
                      <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                        <span className="text-chart-3 mt-1.5 flex-shrink-0">•</span>
                        <span>{rec}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-sm text-muted-foreground">{t("training.noRecommendations")}</li>
                  )}
                </ul>
              </div>
            </div>
          </Card>
        </div>
      ) : !generatingInsights && (
        <Card className="p-8">
          <div className="text-center">
            <Sparkles className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-50" />
            <p className="text-sm text-muted-foreground mb-4">
              {t("training.clickToGenerateInsights")}
            </p>
            <Button
              onClick={generateInsights}
              disabled={featureImportances.length === 0}
              className="bg-gradient-primary hover:shadow-hover"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              {t("training.generateInsights")}
            </Button>
          </div>
        </Card>
      )}

      {/* Loading State */}
      {generatingInsights && (
        <Card className="p-8">
          <div className="text-center">
            <Loader2 className="w-10 h-10 text-primary mx-auto mb-3 animate-spin" />
            <p className="text-sm text-muted-foreground">
              {t("training.generatingInsights")}...
            </p>
          </div>
        </Card>
      )}
    </div>
  );
};

// Helper: parse structured response
function parseStructuredResponse(
  responseText: string,
  topFeatures: FeatureImportanceItem[],
  idColumns: FeatureImportanceItem[],
  isRegression: boolean
): ParsedInsights {
  const extractSection = (text: string, header: string, nextHeaders: string[]): string => {
    const headerPattern = new RegExp(`===${header}===\\s*([\\s\\S]*?)(?=${nextHeaders.map(h => `\\n===${h}===`).join("|")}|$)`, "i");
    const match = text.match(headerPattern);
    return match?.[1]?.trim() || "";
  };

  const parseBullets = (text: string): string[] => {
    if (!text) return [];
    return text.split(/\n/)
      .map(line => line.replace(/^[\s•\-*]+/, '').trim())
      .filter(line => line.length > 0);
  };

  const allHeaders = ["PROBLEMA DE NEGÓCIO INFERIDO", "O QUE ESTAMOS PREVENDO", "QUALIDADE DO MODELO", "O QUE MAIS INFLUENCIA", "RISCOS", "AÇÕES RECOMENDADAS"];

  const businessProblem = extractSection(responseText, allHeaders[0], allHeaders.slice(1));
  const targetExplanation = extractSection(responseText, allHeaders[1], allHeaders.slice(2));
  const modelQuality = extractSection(responseText, allHeaders[2], allHeaders.slice(3));
  const featureInfluence = extractSection(responseText, allHeaders[3], allHeaders.slice(4));
  const risksRaw = extractSection(responseText, allHeaders[4], allHeaders.slice(5));
  const recsRaw = extractSection(responseText, allHeaders[5], []);

  return {
    businessProblem: businessProblem || "",
    targetExplanation: targetExplanation || "",
    modelQuality: modelQuality || "",
    featureInfluence: featureInfluence || topFeatures.map(f => `${f.feature_name} (${(f.importance_value * 100).toFixed(1)}%)`).join(", "),
    risks: parseBullets(risksRaw).length > 0 
      ? parseBullets(risksRaw) 
      : (idColumns.length > 0 ? ["Colunas de ID detectadas entre as features mais importantes — risco de overfitting."] : []),
    recommendations: parseBullets(recsRaw).length > 0 
      ? parseBullets(recsRaw) 
      : ["Analise as features mais influentes e valide se fazem sentido para o negócio."],
  };
}

// Helper: determine confidence level from metrics
function getConfidenceLevel(
  metrics: { metric_name: string; metric_value: number }[],
  isRegression: boolean
): string {
  if (isRegression) {
    const r2 = metrics.find(m => m.metric_name === "R²")?.metric_value || 0;
    if (r2 > 0.8) return "high";
    if (r2 > 0.5) return "medium";
    return "low";
  }
  const auc = metrics.find(m => m.metric_name === "AUC")?.metric_value || 0;
  if (auc > 0.85) return "high";
  if (auc > 0.7) return "medium";
  return "low";
}

export default UnifiedModelInsights;
