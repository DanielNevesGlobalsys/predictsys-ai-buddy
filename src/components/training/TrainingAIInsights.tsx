import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, RefreshCw, Lightbulb, AlertTriangle, TrendingUp } from "lucide-react";
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

interface InsightItem {
  type: "positive" | "negative" | "suggestion";
  text: string;
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
  const [insights, setInsights] = useState<InsightItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    loadExistingInsights();
  }, [projectId, i18n.language]);

  const loadExistingInsights = async () => {
    setInitialLoading(true);
    const { data, error } = await supabase
      .from("project_model_insights")
      .select("insights")
      .eq("project_id", projectId)
      .eq("language", i18n.language)
      .eq("insight_type", "training")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.insights && Array.isArray(data.insights)) {
      setInsights(data.insights as unknown as InsightItem[]);
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
      const productionModel = trainedModels.find(m => m.id === productionModelId);

      const primaryMetric = problemType === "classification" ? "AUC" : "R²";
      
      const modelsSummary = trainedModels.map(m => {
        const metricValue = m.metrics.find(met => met.metric_name === primaryMetric)?.metric_value || 0;
        return `${m.algorithm_name}: ${primaryMetric}=${metricValue.toFixed(4)}`;
      }).join("; ");

      // Gather cumulative context
      let contextBlock = "";
      try {
        const [aiCtxRes, inferenceRes] = await Promise.all([
          supabase.from("project_ai_context").select("context").eq("project_id", projectId).maybeSingle(),
          supabase.from("project_problem_inference").select("problem_type, suggested_problem_labels, narrative").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        ]);
        const aiCtx = aiCtxRes.data?.context as Record<string, any> | null;
        if (aiCtx?.eda?.business_segment?.segment) {
          contextBlock += `\nDomínio: ${aiCtx.eda.business_segment.segment}`;
        }
        if (inferenceRes.data?.suggested_problem_labels) {
          const labels = (inferenceRes.data.suggested_problem_labels as { label: string }[])
            .filter(l => !(l.label || '').startsWith('__'))
            .map(l => l.label);
          if (labels.length > 0) contextBlock += `\nProblemas inferidos: ${labels.join(', ')}`;
        }
      } catch { /* non-critical */ }

      const languageMap: Record<string, string> = {
        pt: "Portuguese (Brazil)",
        en: "English",
        es: "Spanish"
      };

      const systemPrompt = `You are Lys, a business-focused ML analyst. Respond in ${languageMap[i18n.language] || "English"}.
Be concise. Connect ALL insights to the specific business problem. Never use generic phrases like "test other algorithms" alone.`;

      const prompt = `Analyze these ML training results with business context:
${contextBlock}

Problem type: ${problemType}
Target variable: ${targetColumn || "not specified"}
Dataset size: ${datasetRows || "unknown"} rows
Models trained: ${modelsSummary}
Best model: ${bestModel?.algorithm_name || "none"} (${primaryMetric}: ${bestModel?.metrics.find(m => m.metric_name === primaryMetric)?.metric_value?.toFixed(4) || "N/A"})
Production model: ${productionModel?.algorithm_name || "not selected"}

Return a JSON array with exactly 4-5 insights. Each insight must have:
- "type": one of "positive", "negative", or "suggestion"
- "text": the insight text connected to the business problem (1-2 sentences)

Include:
1. Assessment of model performance IN BUSINESS TERMS (what does it mean for the problem?)
2. Strength of the best model relative to the problem
3. Specific risks or limitations for THIS use case
4. 1-2 actionable, problem-specific suggestions

Example format:
[{"type":"positive","text":"The model shows strong predictive power..."},{"type":"suggestion","text":"Consider adding..."}]`;

      const { data, error } = await supabase.functions.invoke("global-chat", {
        body: {
          message: prompt,
          systemPrompt,
        },
      });

      if (error) throw error;

      const responseText = data?.response || data?.text || "";
      
      // Parse JSON from response
      let parsedInsights: InsightItem[] = [];
      try {
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          parsedInsights = JSON.parse(jsonMatch[0]);
        }
      } catch {
        // If parsing fails, create a single insight from the text
        parsedInsights = [{ type: "positive", text: responseText }];
      }

      setInsights(parsedInsights);

      // Save insights to database
      const { error: saveError } = await (supabase
        .from("project_model_insights") as any)
        .insert({
          project_id: projectId,
          model_id: bestModelId || null,
          language: i18n.language,
          insight_type: "training",
          insights: parsedInsights,
        });

      if (saveError) {
        console.error("Error saving insights:", saveError);
      }

      toast.success(t("training.insightsGenerated"));
    } catch (error) {
      console.error("Error generating insights:", error);
      toast.error(t("training.insightsError"));
    } finally {
      setLoading(false);
    }
  };

  const getInsightIcon = (type: string) => {
    switch (type) {
      case "positive":
        return <TrendingUp className="w-4 h-4 text-accent flex-shrink-0" />;
      case "negative":
        return <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />;
      case "suggestion":
        return <Lightbulb className="w-4 h-4 text-secondary flex-shrink-0" />;
      default:
        return <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />;
    }
  };

  const getInsightBg = (type: string) => {
    switch (type) {
      case "positive":
        return "bg-accent/10 border-accent/20";
      case "negative":
        return "bg-destructive/10 border-destructive/20";
      case "suggestion":
        return "bg-secondary/10 border-secondary/20";
      default:
        return "bg-muted";
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
            ) : insights.length > 0 ? (
              <RefreshCw className="w-4 h-4 mr-1" />
            ) : (
              <Sparkles className="w-4 h-4 mr-1" />
            )}
            {insights.length > 0 ? t("training.regenerate") : t("training.generate")}
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          {t("training.aiInsightsDesc")}
        </p>

        {insights.length > 0 ? (
          <div className="space-y-3">
            {insights.map((insight, index) => (
              <div
                key={index}
                className={`flex items-start gap-3 p-3 rounded-lg border ${getInsightBg(insight.type)}`}
              >
                {getInsightIcon(insight.type)}
                <p className="text-sm">{insight.text}</p>
              </div>
            ))}
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
