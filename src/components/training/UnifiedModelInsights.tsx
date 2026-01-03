import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { 
  Loader2, 
  BarChart3, 
  Sparkles, 
  RefreshCw, 
  Lightbulb, 
  AlertTriangle, 
  CheckCircle2, 
  TrendingUp,
  Target
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
  const [insightText, setInsightText] = useState<string | null>(null);
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
      .eq("insight_type", "unified")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.shap_insights) {
      setInsightText(data.shap_insights as string);
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
      const bestModel = trainedModels.find(m => m.id === bestModelId);
      const currentModel = trainedModels.find(m => m.id === modelId);
      
      const primaryMetric = problemType === "classification" ? "AUC" : "R²";
      
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
Be concise, use short sentences. Focus on actionable insights.
Structure your response with these EXACT sections using markdown headers:

## Resumo
(2-3 short sentences about overall model performance - is it good, medium, or needs attention?)

## Principais variáveis do modelo
(For each of the top 3-5 variables, write ONE short bullet explaining what it means for predictions. If any variable contains "id" or "_id", warn that the model might be memorizing IDs instead of learning real patterns.)

## O que isso significa para o negócio
(2-3 short bullet points with business implications)

## Próximos passos sugeridos
(2-3 actionable recommendations as bullet points)`;

      const prompt = `Analyze this ML model and provide insights:

Model: "${modelName}" (${problemType})
Target: ${targetColumn || "not specified"}
Dataset: ${datasetRows || "unknown"} rows
Metrics: ${metricsText || "not available"}

Top feature importances:
${featureList}

${idColumns.length > 0 ? `WARNING: ID columns detected in top features: ${idColumns.map(f => f.feature_name).join(", ")}. This may indicate overfitting.` : ""}

Please provide a structured analysis following the exact format specified.`;

      const { data, error } = await supabase.functions.invoke("global-chat", {
        body: {
          message: prompt,
          systemPrompt,
        },
      });

      if (error) throw error;

      const responseText = data?.response || data?.text || "";
      setInsightText(responseText);

      // Save insights
      await (supabase.from("project_model_insights") as any).insert({
        project_id: projectId,
        model_id: modelId,
        language: i18n.language,
        insight_type: "unified",
        shap_insights: responseText,
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

  const renderFormattedInsights = (text: string) => {
    const lines = text.split('\n');
    const elements: JSX.Element[] = [];
    
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Check for markdown headers
      if (trimmed.startsWith('## ')) {
        const headerText = trimmed.replace('## ', '');
        let icon = <Sparkles className="w-4 h-4" />;
        
        if (headerText.toLowerCase().includes('resumo') || headerText.toLowerCase().includes('summary')) {
          icon = <TrendingUp className="w-4 h-4" />;
        } else if (headerText.toLowerCase().includes('variáv') || headerText.toLowerCase().includes('variable') || headerText.toLowerCase().includes('feature')) {
          icon = <BarChart3 className="w-4 h-4" />;
        } else if (headerText.toLowerCase().includes('negócio') || headerText.toLowerCase().includes('business') || headerText.toLowerCase().includes('significa')) {
          icon = <Lightbulb className="w-4 h-4" />;
        } else if (headerText.toLowerCase().includes('próximos') || headerText.toLowerCase().includes('next') || headerText.toLowerCase().includes('recomend') || headerText.toLowerCase().includes('sugeridos')) {
          icon = <CheckCircle2 className="w-4 h-4" />;
        }

        elements.push(
          <h4 key={idx} className="font-semibold text-sm text-primary flex items-center gap-2 mt-5 first:mt-0 mb-2">
            {icon}
            {headerText}
          </h4>
        );
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.match(/^\d+\./)) {
        const bulletText = trimmed.replace(/^[-•]\s*/, '').replace(/^\d+\.\s*/, '');
        const hasWarning = bulletText.toLowerCase().includes('id') && 
          (bulletText.toLowerCase().includes('overfitting') || 
           bulletText.toLowerCase().includes('memoriz') ||
           bulletText.toLowerCase().includes('risco'));
        
        elements.push(
          <div key={idx} className={`flex items-start gap-2 text-sm pl-2 py-1 ${hasWarning ? 'bg-destructive/5 rounded-md p-2 border-l-2 border-destructive' : ''}`}>
            {hasWarning ? (
              <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            ) : (
              <span className="text-primary mt-0.5">•</span>
            )}
            <span className={hasWarning ? 'text-destructive-foreground' : 'text-muted-foreground'}>{bulletText}</span>
          </div>
        );
      } else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        elements.push(
          <p key={idx} className="text-sm font-medium text-foreground">
            {trimmed.replace(/\*\*/g, '')}
          </p>
        );
      } else {
        elements.push(
          <p key={idx} className="text-sm text-muted-foreground leading-relaxed">
            {trimmed}
          </p>
        );
      }
    });

    return <div className="space-y-1">{elements}</div>;
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
    <Card className="p-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-secondary/10 rounded-lg flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-secondary" />
            </div>
            <div>
              <h3 className="font-semibold">{t("training.unifiedInsightsTitle")}</h3>
              <p className="text-sm text-muted-foreground">
                {t("training.unifiedInsightsSubtitle")}
              </p>
            </div>
          </div>
          {modelName && (
            <span className="text-sm text-muted-foreground bg-muted px-3 py-1 rounded-full">
              {modelName}
            </span>
          )}
        </div>

        {/* Feature Importance Bars */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : featureImportances.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <BarChart3 className="w-4 h-4 text-primary" />
              {t("training.featureImportance")}
            </div>
            <div className="grid gap-2">
              {featureImportances.slice(0, 5).map((feature, index) => {
                const isIdColumn = feature.feature_name.toLowerCase().includes("id");
                return (
                  <div key={feature.feature_name} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className={`font-medium truncate max-w-[200px] flex items-center gap-1 ${isIdColumn ? 'text-destructive' : ''}`}>
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
          </div>
        )}

        {/* Generate/Regenerate Button */}
        <div className="flex justify-center pt-2">
          <Button
            variant={insightText ? "outline" : "default"}
            onClick={generateInsights}
            disabled={generatingInsights || featureImportances.length === 0}
            className={!insightText ? "bg-gradient-primary hover:shadow-hover" : ""}
          >
            {generatingInsights ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                {t("training.generatingInsights")}
              </>
            ) : insightText ? (
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

        {/* Insights Content */}
        {insightText ? (
          <div className="p-4 bg-secondary/5 border border-secondary/20 rounded-lg">
            {renderFormattedInsights(insightText)}
          </div>
        ) : !generatingInsights && (
          <div className="text-center py-6 bg-muted/30 rounded-lg border border-dashed border-border">
            <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {t("training.clickToGenerateInsights")}
            </p>
          </div>
        )}

        {/* Error State */}
        {!loading && featureImportances.length === 0 && (
          <div className="text-center py-4 text-muted-foreground">
            <p className="text-sm">{t("training.noFeatureImportances")}</p>
          </div>
        )}
      </div>
    </Card>
  );
};

export default UnifiedModelInsights;
