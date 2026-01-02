import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, RefreshCw, Loader2, TrendingUp, AlertTriangle, Lightbulb, Target } from "lucide-react";
import type { Json } from "@/integrations/supabase/types";

interface DashboardAIInsightsProps {
  projectId: string;
  modelId: string;
  problemType: string;
}

interface AIInsight {
  type: "summary" | "risks" | "opportunities" | "actions";
  content: string;
}

const DashboardAIInsights = ({ projectId, modelId, problemType }: DashboardAIInsightsProps) => {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [hasStoredInsights, setHasStoredInsights] = useState(false);

  useEffect(() => {
    loadStoredInsights();
  }, [projectId, modelId, i18n.language]);

  const loadStoredInsights = async () => {
    try {
      const { data, error } = await supabase
        .from("project_model_insights")
        .select("*")
        .eq("project_id", projectId)
        .eq("model_id", modelId)
        .eq("insight_type", "dashboard")
        .eq("language", i18n.language.split("-")[0])
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (data && !error) {
        const insightsData = data.insights as any[];
        if (Array.isArray(insightsData) && insightsData.length > 0) {
          setInsights(insightsData);
          setHasStoredInsights(true);
        }
      }
    } catch (error) {
      // No stored insights found
    }
  };

  const generateInsights = async () => {
    setLoading(true);
    try {
      // Simulate AI insight generation
      const newInsights: AIInsight[] = [
        {
          type: "summary",
          content: problemType === "classification"
            ? t("modelDashboard.aiInsights.summaryClassification")
            : t("modelDashboard.aiInsights.summaryRegression"),
        },
        {
          type: "risks",
          content: t("modelDashboard.aiInsights.risksText"),
        },
        {
          type: "opportunities",
          content: t("modelDashboard.aiInsights.opportunitiesText"),
        },
        {
          type: "actions",
          content: t("modelDashboard.aiInsights.actionsText"),
        },
      ];

      // Check if insights already exist
      const { data: existing } = await supabase
        .from("project_model_insights")
        .select("id")
        .eq("project_id", projectId)
        .eq("model_id", modelId)
        .eq("insight_type", "dashboard")
        .eq("language", i18n.language.split("-")[0])
        .single();

      const insightsJson = JSON.parse(JSON.stringify(newInsights)) as Json;

      if (existing) {
        // Update existing
        const { error } = await supabase
          .from("project_model_insights")
          .update({
            insights: insightsJson,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        // Insert new
        const { error } = await supabase
          .from("project_model_insights")
          .insert([{
            project_id: projectId,
            model_id: modelId,
            insight_type: "dashboard",
            language: i18n.language.split("-")[0],
            insights: insightsJson,
          }]);
        if (error) throw error;
      }

      setInsights(newInsights);
      setHasStoredInsights(true);
      toast.success(t("modelDashboard.aiInsights.generated"));
    } catch (error) {
      console.error("Error generating insights:", error);
      toast.error(t("modelDashboard.aiInsights.error"));
    }
    setLoading(false);
  };

  const getInsightIcon = (type: AIInsight["type"]) => {
    switch (type) {
      case "summary":
        return <TrendingUp className="w-5 h-5" />;
      case "risks":
        return <AlertTriangle className="w-5 h-5" />;
      case "opportunities":
        return <Lightbulb className="w-5 h-5" />;
      case "actions":
        return <Target className="w-5 h-5" />;
    }
  };

  const getInsightColor = (type: AIInsight["type"]) => {
    switch (type) {
      case "summary":
        return "text-primary bg-primary/10";
      case "risks":
        return "text-destructive bg-destructive/10";
      case "opportunities":
        return "text-accent bg-accent/10";
      case "actions":
        return "text-secondary bg-secondary/10";
    }
  };

  const getInsightTitle = (type: AIInsight["type"]) => {
    switch (type) {
      case "summary":
        return t("modelDashboard.aiInsights.summary");
      case "risks":
        return t("modelDashboard.aiInsights.risks");
      case "opportunities":
        return t("modelDashboard.aiInsights.opportunities");
      case "actions":
        return t("modelDashboard.aiInsights.actions");
    }
  };

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">{t("modelDashboard.aiInsights.title")}</h3>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={generateInsights}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          {hasStoredInsights
            ? t("modelDashboard.aiInsights.regenerate")
            : t("modelDashboard.aiInsights.generate")}
        </Button>
      </div>

      {insights.length === 0 ? (
        <div className="text-center py-8">
          <Sparkles className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">{t("modelDashboard.aiInsights.noInsights")}</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {insights.map((insight, index) => (
            <div
              key={index}
              className="p-4 rounded-lg border border-border bg-card"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className={`p-2 rounded-lg ${getInsightColor(insight.type)}`}>
                  {getInsightIcon(insight.type)}
                </div>
                <h4 className="font-medium">{getInsightTitle(insight.type)}</h4>
              </div>
              <p className="text-sm text-muted-foreground">{insight.content}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

export default DashboardAIInsights;
