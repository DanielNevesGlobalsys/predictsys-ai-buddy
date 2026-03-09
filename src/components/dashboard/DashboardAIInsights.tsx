import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, RefreshCw, Loader2, TrendingUp, AlertTriangle, Lightbulb, Target } from "lucide-react";

interface DashboardAIInsightsProps {
  projectId: string;
  modelId: string;
  problemType: string;
}

interface ModelInterpretationInsight {
  narrative: string;
  reliability_assessment: string;
  key_drivers: string[];
  limitations: string[];
  recommended_usage: string;
}

const DashboardAIInsights = ({ projectId, modelId, problemType }: DashboardAIInsightsProps) => {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [insight, setInsight] = useState<ModelInterpretationInsight | null>(null);
  const [hasStored, setHasStored] = useState(false);

  useEffect(() => {
    loadStoredInsights();
  }, [projectId, modelId, i18n.language]);

  const loadStoredInsights = async () => {
    try {
      const { data } = await supabase
        .from("project_model_insights")
        .select("insights")
        .eq("project_id", projectId)
        .eq("insight_type", "model_interpretation")
        .eq("language", i18n.language)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data?.insights) {
        const parsed = typeof data.insights === "string" ? JSON.parse(data.insights) : data.insights;
        if (parsed?.narrative) {
          setInsight(parsed as ModelInterpretationInsight);
          setHasStored(true);
        }
      }
    } catch (error) {
      // No stored insights found
    }
  };

  const generateInsights = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("lys-pipeline-insights", {
        body: {
          project_id: projectId,
          stage: "model_interpretation",
          language: i18n.language,
          extra_context: { model_id: modelId, problem_type: problemType },
        },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Failed");

      setInsight(data.insight as ModelInterpretationInsight);
      setHasStored(true);
      toast.success(t("modelDashboard.aiInsights.generated"));
    } catch (error) {
      console.error("Error generating insights:", error);
      toast.error(t("modelDashboard.aiInsights.error"));
    }
    setLoading(false);
  };

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">{t("modelDashboard.aiInsights.title")}</h3>
        </div>
        <Button variant="outline" size="sm" onClick={generateInsights} disabled={loading}>
          {loading ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          {hasStored
            ? t("modelDashboard.aiInsights.regenerate")
            : t("modelDashboard.aiInsights.generate")}
        </Button>
      </div>

      {!insight ? (
        <div className="text-center py-8">
          <Sparkles className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">{t("modelDashboard.aiInsights.noInsights")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {insight.narrative && (
            <div className="p-4 rounded-lg border border-border bg-card">
              <p className="text-sm leading-relaxed whitespace-pre-line">{insight.narrative}</p>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3">
            {insight.key_drivers?.length > 0 && (
              <div className="p-3 rounded-lg border bg-primary/5 border-primary/20">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">{t("modelDashboard.aiInsights.summary")}</span>
                </div>
                <ul className="space-y-1">
                  {insight.key_drivers.map((d, i) => (
                    <li key={i} className="text-xs flex gap-1.5">
                      <span className="text-primary font-bold">•</span><span>{d}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {insight.limitations?.length > 0 && (
              <div className="p-3 rounded-lg border bg-destructive/5 border-destructive/20">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                  <span className="text-sm font-medium">{t("modelDashboard.aiInsights.risks")}</span>
                </div>
                <ul className="space-y-1">
                  {insight.limitations.map((l, i) => (
                    <li key={i} className="text-xs flex gap-1.5">
                      <span className="text-destructive font-bold">•</span><span>{l}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {insight.recommended_usage && (
            <div className="p-3 rounded-lg bg-muted/50 border border-border flex items-start gap-2">
              <Lightbulb className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <p className="text-xs text-muted-foreground">{insight.recommended_usage}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};

export default DashboardAIInsights;
