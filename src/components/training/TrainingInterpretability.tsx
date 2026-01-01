import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, BarChart3, Sparkles, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface FeatureImportance {
  feature_name: string;
  importance_value: number;
}

interface TrainingInterpretabilityProps {
  projectId: string;
  modelId?: string;
  modelName?: string;
  problemType: string;
}

const TrainingInterpretability = ({
  projectId,
  modelId,
  modelName,
  problemType,
}: TrainingInterpretabilityProps) => {
  const { t, i18n } = useTranslation();
  const [featureImportances, setFeatureImportances] = useState<FeatureImportance[]>([]);
  const [shapInsights, setShapInsights] = useState<string | null>(null);
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

    const { data, error } = await supabase
      .from("project_model_insights")
      .select("shap_insights")
      .eq("project_id", projectId)
      .eq("model_id", modelId)
      .eq("language", i18n.language)
      .eq("insight_type", "shap")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.shap_insights) {
      setShapInsights(data.shap_insights as string);
    }
  };

  const generateShapInsights = async () => {
    if (!modelId || featureImportances.length === 0) return;

    setGeneratingInsights(true);
    try {
      const topFeatures = featureImportances.slice(0, 5);
      const featureList = topFeatures.map(f => 
        `${f.feature_name}: ${(f.importance_value * 100).toFixed(1)}%`
      ).join(", ");

      const systemPrompt = `You are a data science expert explaining model interpretability in business language. 
Respond in ${i18n.language === 'pt' ? 'Portuguese (Brazil)' : i18n.language === 'es' ? 'Spanish' : 'English'}.
Be concise but insightful. Focus on business implications.`;

      const prompt = `The model "${modelName}" (${problemType}) has the following top feature importances:
${featureList}

Write 2-3 short sentences explaining:
1. Which variables most influence predictions
2. What this means for business decision-making
3. Any potential concerns or insights`;

      const { data, error } = await supabase.functions.invoke("global-chat", {
        body: {
          message: prompt,
          systemPrompt,
        },
      });

      if (error) throw error;

      const insightText = data?.response || data?.text || "";
      setShapInsights(insightText);

      // Save insights
      await (supabase.from("project_model_insights") as any).insert({
        project_id: projectId,
        model_id: modelId,
        language: i18n.language,
        insight_type: "shap",
        shap_insights: insightText,
        insights: [],
      });

      toast.success(t("training.insightsGenerated"));
    } catch (error) {
      console.error("Error generating SHAP insights:", error);
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
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>{t("training.selectModelForInterpretability")}</p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">{t("training.featureImportance")}</h3>
          </div>
          {modelName && (
            <span className="text-sm text-muted-foreground">
              {t("training.model")}: {modelName}
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : featureImportances.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            {t("training.noFeatureImportances")}
          </p>
        ) : (
          <div className="space-y-3">
            {featureImportances.map((feature, index) => (
              <div key={feature.feature_name} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium truncate max-w-[200px]">
                    {index + 1}. {feature.feature_name}
                  </span>
                  <span className="text-muted-foreground">
                    {(feature.importance_value * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-primary to-primary/60 rounded-full transition-all"
                    style={{ width: `${(feature.importance_value / maxImportance) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* SHAP Insights Section */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-secondary" />
              <h4 className="font-medium text-sm">{t("training.aiInsightsShap")}</h4>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={generateShapInsights}
              disabled={generatingInsights || featureImportances.length === 0}
            >
              {generatingInsights ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : shapInsights ? (
                <RefreshCw className="w-4 h-4 mr-1" />
              ) : (
                <Sparkles className="w-4 h-4 mr-1" />
              )}
              {shapInsights ? t("training.regenerate") : t("training.generate")}
            </Button>
          </div>

          {shapInsights ? (
            <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
              <p className="text-sm">{shapInsights}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-3">
              {t("training.clickToGenerateShapInsights")}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
};

export default TrainingInterpretability;
