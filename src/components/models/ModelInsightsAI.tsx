import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, RefreshCw } from "lucide-react";
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
  const [insights, setInsights] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(true);

  useEffect(() => {
    loadExistingInsights();
  }, [projectId, i18n.language]);

  const loadExistingInsights = async () => {
    setLoadingExisting(true);
    try {
      const { data, error } = await supabase
        .from("project_eda_insights")
        .select("*")
        .eq("project_id", projectId)
        .eq("language", i18n.language)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!error && data && data.length > 0) {
        const insightsData = data[0].insights;
        if (Array.isArray(insightsData)) {
          const stringInsights = insightsData.map((i) => String(i));
          const modelInsights = stringInsights.filter((insight: string) => 
            insight.includes("model") || insight.includes("modelo") || 
            insight.includes("AUC") || insight.includes("RMSE") ||
            insight.includes("algoritmo") || insight.includes("algorithm")
          );
          if (modelInsights.length > 0) {
            setInsights(modelInsights);
          }
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
      const productionModel = models.find(m => m.id === productionModelId);
      
      const primaryMetric = problemType === "classification" ? "AUC" : "R²";
      
      const modelsSummary = models
        .filter(m => m.status === "trained")
        .map(m => {
          const metricValue = m.metrics.find(metric => metric.metric_name === primaryMetric)?.metric_value;
          return `${m.algorithm_name}: ${primaryMetric}=${metricValue?.toFixed(4) || "N/A"}`;
        })
        .join("; ");

      const prompt = `Analyze these ML model results and provide 4-5 short, actionable business insights in ${i18n.language === "pt" ? "Portuguese" : i18n.language === "es" ? "Spanish" : "English"}.

Problem type: ${problemType}
Target variable: ${targetColumn || "unknown"}
Dataset size: ${datasetRows || "unknown"} rows
Models trained: ${modelsSummary}
Best model: ${bestModel?.algorithm_name || "none"} (${primaryMetric}: ${bestModel?.metrics.find(m => m.metric_name === primaryMetric)?.metric_value?.toFixed(4) || "N/A"})
Production model: ${productionModel?.algorithm_name || "not selected"}

Consider:
1. Is the model performance good, medium, or weak for this type of problem?
2. What are the strengths of the best model?
3. What are the risks or limitations (overfitting, low recall, etc.)?
4. Suggestions for improvement (different features, more data, class balancing, etc.)
5. Business recommendations

Return a JSON array of strings, each being a complete insight. Format: ["insight 1", "insight 2", ...]`;

      const { data, error } = await supabase.functions.invoke("global-chat", {
        body: { message: prompt, language: i18n.language }
      });

      if (error) throw error;

      const responseText = data?.response || "";
      
      // Parse insights from response
      let parsedInsights: string[] = [];
      try {
        const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          parsedInsights = JSON.parse(jsonMatch[0]);
        } else {
          // Fallback: split by newlines and clean
          parsedInsights = responseText
            .split(/\n/)
            .filter((line: string) => line.trim().length > 10)
            .slice(0, 5);
        }
      } catch {
        parsedInsights = responseText
          .split(/\n/)
          .filter((line: string) => line.trim().length > 10)
          .slice(0, 5);
      }

      if (parsedInsights.length > 0) {
        setInsights(parsedInsights);
        
        // Save to database
        await supabase
          .from("project_eda_insights")
          .upsert({
            project_id: projectId,
            language: i18n.language,
            insights: parsedInsights,
            updated_at: new Date().toISOString()
          }, {
            onConflict: "project_id,language"
          });

        toast.success(t("models.insights.generated"));
      }
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
            ) : insights.length > 0 ? (
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
        {insights.length > 0 ? (
          <ul className="space-y-3">
            {insights.map((insight, idx) => (
              <li key={idx} className="flex gap-3 text-sm">
                <span className="text-primary font-bold">{idx + 1}.</span>
                <span className="text-foreground">{insight}</span>
              </li>
            ))}
          </ul>
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
