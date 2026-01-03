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
  CheckCircle2
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface FeatureImportance {
  feature_name: string;
  importance_value: number;
}

interface ModelResult {
  id: string;
  algorithm_name: string;
  status: string;
  is_production: boolean;
  metrics: { metric_name: string; metric_value: number }[];
}

interface ParsedInsights {
  summary: string;
  featureImportance: string;
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
  const [featureImportances, setFeatureImportances] = useState<FeatureImportance[]>([]);
  const [parsedInsights, setParsedInsights] = useState<ParsedInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatingInsights, setGeneratingInsights] = useState(false);

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
        const rawInsights = typeof data.shap_insights === 'string' 
          ? JSON.parse(data.shap_insights) 
          : data.shap_insights;
        
        // Ensure all fields exist with proper defaults
        const parsed: ParsedInsights = {
          summary: rawInsights?.summary || "",
          featureImportance: rawInsights?.featureImportance || "",
          risks: Array.isArray(rawInsights?.risks) ? rawInsights.risks : [],
          recommendations: Array.isArray(rawInsights?.recommendations) ? rawInsights.recommendations : [],
        };
        setParsedInsights(parsed);
      } catch (e) {
        console.error("Error parsing saved insights:", e);
        setParsedInsights(null);
      }
    }
  };

  const generateInsights = async () => {
    if (!modelId || featureImportances.length === 0) {
      toast.error(t("training.noFeatureImportances"));
      return;
    }

    setGeneratingInsights(true);
    try {
      const trainedModels = models.filter(m => m.status === "trained");
      const currentModel = trainedModels.find(m => m.id === modelId);
      
      // Build metrics summary
      const currentMetrics = currentModel?.metrics || [];
      const metricsText = currentMetrics
        .filter(m => ["AUC", "F1", "Precision", "Recall", "Accuracy", "R²", "MAE", "RMSE"].includes(m.metric_name))
        .map(m => `${m.metric_name}: ${(m.metric_value * 100).toFixed(1)}%`)
        .join(", ");

      // Build feature importances text
      const topFeatures = featureImportances.slice(0, 5);
      const featureList = topFeatures.map(f => 
        `- ${f.feature_name}: ${(f.importance_value * 100).toFixed(1)}%`
      ).join("\n");

      // Check for ID columns
      const idColumns = topFeatures.filter(f => 
        f.feature_name.toLowerCase().includes("id") || 
        f.feature_name.toLowerCase().includes("_id") ||
        f.feature_name.toLowerCase() === "id"
      );

      const lang = i18n.language === 'pt' ? 'Portuguese (Brazil)' : i18n.language === 'es' ? 'Spanish' : 'English';
      
      const systemPrompt = `You are a friendly data science expert who explains ML models in simple business language.
Respond in ${lang}.
You MUST return a valid JSON object with exactly this structure (no markdown, no extra text):
{
  "summary": "2-3 short sentences about overall model performance",
  "featureImportance": "Short paragraph explaining the top 3-5 variables and what they mean. If any variable contains 'id', warn about overfitting risk.",
  "risks": ["risk 1", "risk 2", "risk 3"],
  "recommendations": ["recommendation 1", "recommendation 2", "recommendation 3"]
}

Keep all text concise and business-focused. Maximum 2-3 sentences for summary and featureImportance.
For risks and recommendations, use 2-4 short bullet items each.`;

      const prompt = `Analyze this ML model and provide insights as JSON:

Model: "${modelName}" (${problemType})
Target: ${targetColumn || "not specified"}
Dataset: ${datasetRows || "unknown"} rows
Metrics: ${metricsText || "not available"}

Top feature importances:
${featureList}

${idColumns.length > 0 ? `WARNING: ID columns detected in top features: ${idColumns.map(f => f.feature_name).join(", ")}. This indicates overfitting risk.` : ""}

Return ONLY a valid JSON object with summary, featureImportance, risks, and recommendations fields.`;

      const { data, error } = await supabase.functions.invoke("global-chat", {
        body: {
          message: prompt,
          systemPrompt,
        },
      });

      if (error) throw error;

      const responseText = data?.response || data?.text || "";
      
      // Parse JSON from response
      let parsed: ParsedInsights;
      try {
        // Try to extract JSON from the response
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error("No JSON found in response");
        }
      } catch {
        // Fallback structure if parsing fails
        parsed = {
          summary: responseText.slice(0, 200),
          featureImportance: topFeatures.map(f => `${f.feature_name} (${(f.importance_value * 100).toFixed(1)}%)`).join(", "),
          risks: idColumns.length > 0 ? ["Possível overfitting devido a colunas de ID com alta importância."] : ["Sem riscos críticos identificados."],
          recommendations: ["Testar outros algoritmos para comparação.", "Monitorar a performance em dados novos."]
        };
      }

      setParsedInsights(parsed);

      // Save insights as JSON
      await (supabase.from("project_model_insights") as any).insert({
        project_id: projectId,
        model_id: modelId,
        language: i18n.language,
        insight_type: "unified_cards",
        shap_insights: JSON.stringify(parsed),
        insights: [],
      });

      toast.success(t("training.insightsGenerated"));
    } catch (error) {
      console.error("Error generating insights:", error);
      toast.error(t("training.insightsError"));
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

      {/* Insights Cards Grid */}
      {parsedInsights ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Card 1 - Summary */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-chart-1/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <TrendingUp className="w-4 h-4 text-chart-1" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm mb-2">{t("training.insightsSummary")}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {parsedInsights.summary || t("training.noInsightsAvailable")}
                </p>
              </div>
            </div>
          </Card>

          {/* Card 2 - Feature Importance Explanation */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-chart-2/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <BarChart3 className="w-4 h-4 text-chart-2" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm mb-2">{t("training.insightsFeatureImportance")}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {parsedInsights.featureImportance || t("training.noInsightsAvailable")}
                </p>
              </div>
            </div>
          </Card>

          {/* Card 3 - Risks */}
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

          {/* Card 4 - Recommendations */}
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

export default UnifiedModelInsights;
