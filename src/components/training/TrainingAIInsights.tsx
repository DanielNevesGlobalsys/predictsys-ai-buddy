import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, RefreshCw, Lightbulb, AlertTriangle, TrendingUp, Target } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface ModelResult {
  id: string;
  algorithm_name: string;
  status: string;
  is_production: boolean;
  metrics: { metric_name: string; metric_value: number }[];
}

interface TrainingAIInsightsProps {
  projectId: string;
  models: ModelResult[];
  problemType: string;
  bestModelId?: string;
  productionModelId?: string;
  datasetRows?: number;
  targetColumn?: string;
}

interface ModelInterpretationInsight {
  narrative: string;
  reliability_assessment: string;
  key_drivers: string[];
  limitations: string[];
  recommended_usage: string;
}

const TrainingAIInsights = ({
  projectId,
  models,
  problemType,
  bestModelId,
  productionModelId,
  datasetRows,
  targetColumn,
}: TrainingAIInsightsProps) => {
  const { t, i18n } = useTranslation();
  const [insight, setInsight] = useState<ModelInterpretationInsight | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    loadExistingInsights();
  }, [projectId, i18n.language]);

  const loadExistingInsights = async () => {
    setInitialLoading(true);
    const { data } = await supabase
      .from("project_model_insights")
      .select("insights")
      .eq("project_id", projectId)
      .eq("language", i18n.language)
      .eq("insight_type", "model_interpretation")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.insights) {
      const parsed = typeof data.insights === "string" ? JSON.parse(data.insights) : data.insights;
      if (parsed?.narrative) {
        setInsight(parsed as ModelInterpretationInsight);
      }
    }
    setInitialLoading(false);
  };

  const generateInsights = async () => {
    if (models.length === 0) {
      toast.error(t("training.noModelsForInsights"));
      return;
    }

    setLoading(true);
    try {
      const trainedModels = models.filter(m => m.status === "trained");
      const bestModel = trainedModels.find(m => m.id === bestModelId);
      const primaryMetric = problemType === "classification" ? "AUC" : "R²";

      const extraContext = {
        trained_models: trainedModels.map(m => ({
          algorithm: m.algorithm_name,
          is_best: m.id === bestModelId,
          is_production: m.id === productionModelId,
          metrics: Object.fromEntries(m.metrics.map(met => [met.metric_name, met.metric_value])),
        })),
        best_model_algorithm: bestModel?.algorithm_name || null,
        primary_metric: primaryMetric,
        dataset_rows: datasetRows,
        target_column: targetColumn,
      };

      const { data, error } = await supabase.functions.invoke("lys-pipeline-insights", {
        body: {
          project_id: projectId,
          stage: "model_interpretation",
          language: i18n.language,
          extra_context: extraContext,
        },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Failed to generate insights");

      const newInsight = data.insight as ModelInterpretationInsight;
      setInsight(newInsight);

      // Update AI context with training stage
      try {
        await supabase.functions.invoke("append-project-context", {
          body: {
            project_id: projectId,
            stage: "training",
            payload: {
              model_type: bestModel?.algorithm_name || "",
              metrics: Object.fromEntries((bestModel?.metrics || []).map(m => [m.metric_name, m.metric_value])),
              confidence_level: "medium",
              limitations: newInsight.limitations || [],
            },
          },
        });
      } catch { /* non-critical */ }

      toast.success(t("training.insightsGenerated"));
    } catch (error) {
      console.error("Error generating model insights:", error);
      toast.error(t("training.insightsError"));
    } finally {
      setLoading(false);
    }
  };

  if (initialLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-secondary" />
            <h3 className="font-semibold">{t("training.aiInsights")}</h3>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={generateInsights}
            disabled={loading || models.length === 0}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
            ) : insight ? (
              <RefreshCw className="w-4 h-4 mr-1" />
            ) : (
              <Sparkles className="w-4 h-4 mr-1" />
            )}
            {insight ? t("training.regenerate") : t("training.generate")}
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          {t("training.aiInsightsDesc")}
        </p>

        {insight ? (
          <div className="space-y-4">
            {/* Narrative */}
            {insight.narrative && (
              <div className="p-4 rounded-lg border bg-card">
                <p className="text-sm leading-relaxed whitespace-pre-line">{insight.narrative}</p>
              </div>
            )}

            {/* Key Drivers */}
            {insight.key_drivers?.length > 0 && (
              <div className="p-3 rounded-lg border bg-accent/5 border-accent/20">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="w-4 h-4 text-accent" />
                  <span className="text-sm font-medium">Principais fatores de influência</span>
                </div>
                <ul className="space-y-1">
                  {insight.key_drivers.map((d, i) => (
                    <li key={i} className="text-sm flex gap-2">
                      <span className="text-accent font-bold">•</span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Limitations */}
            {insight.limitations?.length > 0 && (
              <div className="p-3 rounded-lg border bg-destructive/5 border-destructive/20">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                  <span className="text-sm font-medium">Limitações</span>
                </div>
                <ul className="space-y-1">
                  {insight.limitations.map((l, i) => (
                    <li key={i} className="text-sm flex gap-2">
                      <span className="text-destructive font-bold">•</span>
                      <span>{l}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recommended Usage */}
            {insight.recommended_usage && (
              <div className="p-3 rounded-lg bg-muted/50 border border-border">
                <div className="flex items-center gap-2 mb-2">
                  <Target className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">Uso recomendado</span>
                </div>
                <p className="text-sm text-muted-foreground">{insight.recommended_usage}</p>
              </div>
            )}

            {/* Reliability */}
            {insight.reliability_assessment && (
              <div className="p-2 rounded bg-muted/30 border border-border">
                <p className="text-xs text-muted-foreground italic">
                  <Lightbulb className="w-3 h-3 inline mr-1" />
                  {insight.reliability_assessment}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-6 text-muted-foreground">
            <Sparkles className="w-10 h-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{t("training.clickToGenerateInsights")}</p>
          </div>
        )}
      </div>
    </Card>
  );
};

export default TrainingAIInsights;
