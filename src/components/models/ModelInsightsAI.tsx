import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, RefreshCw, TrendingUp, AlertTriangle, Lightbulb, Target } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface ModelMetric {
  metric_name: string;
  metric_value: number;
}

interface ModelResult {
  id: string;
  algorithm_name: string;
  status: string;
  is_production: boolean;
  metrics: ModelMetric[];
}

interface ModelInsightsAIProps {
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

const ModelInsightsAI = ({
  projectId,
  models,
  problemType,
  bestModelId,
  productionModelId,
  datasetRows,
  targetColumn
}: ModelInsightsAIProps) => {
  const { t, i18n } = useTranslation();
  const [insight, setInsight] = useState<ModelInterpretationInsight | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(true);

  useEffect(() => {
    loadExistingInsights();
  }, [projectId, i18n.language]);

  const loadExistingInsights = async () => {
    setLoadingExisting(true);
    try {
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
    } catch (err) {
      console.error("Error loading model insights:", err);
    } finally {
      setLoadingExisting(false);
    }
  };

  const generateInsights = async () => {
    if (models.length === 0) return;

    setLoading(true);
    try {
      const bestModel = models.find(m => m.id === bestModelId);
      const primaryMetric = problemType === "classification" ? "AUC" : "R²";

      const extraContext = {
        trained_models: models.filter(m => m.status === "trained").map(m => ({
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
      if (!data?.success) throw new Error(data?.error || "Failed");

      setInsight(data.insight as ModelInterpretationInsight);
      toast.success(t("models.insights.generated"));
    } catch (err) {
      console.error("Error generating model insights:", err);
      toast.error(t("models.insights.error"));
    } finally {
      setLoading(false);
    }
  };

  if (loadingExisting) {
    return (
      <Card className="bg-gradient-card shadow-card">
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-gradient-card shadow-card border-primary/20">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">{t("models.insights.title")}</CardTitle>
              <CardDescription>{t("models.insights.description")}</CardDescription>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={generateInsights}
            disabled={loading || models.length === 0}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t("models.insights.generating")}
              </>
            ) : insight ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                {t("models.insights.regenerate")}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                {t("models.insights.generate")}
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {insight ? (
          <div className="space-y-4">
            {insight.narrative && (
              <p className="text-sm leading-relaxed whitespace-pre-line">{insight.narrative}</p>
            )}

            {insight.key_drivers?.length > 0 && (
              <div className="p-3 rounded-lg bg-accent/5 border border-accent/20">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="w-4 h-4 text-accent" />
                  <span className="text-sm font-medium">Fatores de influência</span>
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

            {insight.limitations?.length > 0 && (
              <div className="p-3 rounded-lg bg-destructive/5 border border-destructive/20">
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

            {insight.recommended_usage && (
              <div className="p-3 rounded-lg bg-muted/50 border border-border flex items-start gap-2">
                <Target className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                <p className="text-xs text-muted-foreground">{insight.recommended_usage}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            {t("models.insights.noInsights")}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default ModelInsightsAI;
