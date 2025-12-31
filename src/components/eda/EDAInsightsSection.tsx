import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles, Loader2, RefreshCw, Lightbulb, TrendingUp, AlertTriangle, Target } from "lucide-react";

interface NumericStat {
  column_name: string;
  mean_value: number | null;
  std_value: number | null;
  null_count: number;
}

interface CategoricalStat {
  column_name: string;
  distinct_count: number;
  top_categories: { category: string; count: number }[];
}

interface EDAInsightsSectionProps {
  numericStats: NumericStat[];
  categoricalStats: CategoricalStat[];
  totalRows: number;
  targetColumn?: string;
  projectName: string;
}

const EDAInsightsSection = ({
  numericStats,
  categoricalStats,
  totalRows,
  targetColumn,
  projectName,
}: EDAInsightsSectionProps) => {
  const { t, i18n } = useTranslation();
  const [insights, setInsights] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateInsights = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Prepare context for AI
      const numericSummary = numericStats.map(s => ({
        name: s.column_name,
        mean: s.mean_value?.toFixed(2),
        std: s.std_value?.toFixed(2),
        missing: s.null_count,
        missingPct: ((s.null_count / totalRows) * 100).toFixed(1)
      }));

      const categoricalSummary = categoricalStats.map(s => ({
        name: s.column_name,
        categories: s.distinct_count,
        topCategory: s.top_categories[0]?.category,
        topCount: s.top_categories[0]?.count,
        topPct: s.top_categories[0] ? ((s.top_categories[0].count / totalRows) * 100).toFixed(1) : 0
      }));

      const languageMap: Record<string, string> = {
        'pt': 'Portuguese',
        'pt-BR': 'Portuguese',
        'en': 'English',
        'es': 'Spanish'
      };
      const language = languageMap[i18n.language] || 'English';

      const prompt = `Analyze this dataset summary and provide 4-5 short, actionable business insights in ${language}.

Project: ${projectName}
Total rows: ${totalRows}
Target variable: ${targetColumn || 'Not defined'}

Numeric columns:
${JSON.stringify(numericSummary, null, 2)}

Categorical columns:
${JSON.stringify(categoricalSummary, null, 2)}

Requirements:
- Each insight should be 1-2 sentences max
- Focus on business value and actionable observations
- Mention specific column names and values
- Highlight potential issues (high missing data, imbalanced categories, outliers)
- Suggest what might be important for prediction
- Response format: JSON array of strings, e.g. ["insight 1", "insight 2", ...]`;

      const { data, error: fnError } = await supabase.functions.invoke("global-chat", {
        body: {
          message: prompt,
          language: i18n.language,
        },
      });

      if (fnError) throw fnError;

      // Try to parse JSON from response
      const responseText = data?.response || data?.message || "";
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        setInsights(parsed);
      } else {
        // Fallback: split by newlines if not JSON
        const lines = responseText.split('\n').filter((l: string) => l.trim().length > 10);
        setInsights(lines.slice(0, 5));
      }
    } catch (err: any) {
      console.error("Error generating insights:", err);
      setError(err.message || t("eda.insights.error"));
    }
    
    setLoading(false);
  };

  const getInsightIcon = (index: number) => {
    const icons = [Lightbulb, TrendingUp, Target, AlertTriangle, Sparkles];
    const Icon = icons[index % icons.length];
    return <Icon className="w-4 h-4" />;
  };

  const getInsightColor = (index: number) => {
    const colors = [
      "bg-primary/10 text-primary",
      "bg-secondary/10 text-secondary",
      "bg-chart-1/10 text-chart-1",
      "bg-chart-2/10 text-chart-2",
      "bg-chart-3/10 text-chart-3",
    ];
    return colors[index % colors.length];
  };

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold">{t("eda.insights.title")}</h3>
            <p className="text-sm text-muted-foreground">{t("eda.insights.description")}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={generateInsights}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : insights.length > 0 ? (
            <RefreshCw className="w-4 h-4" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          <span className="ml-2">
            {loading ? t("eda.insights.generating") : insights.length > 0 ? t("eda.insights.regenerate") : t("eda.insights.title")}
          </span>
        </Button>
      </div>

      {error && (
        <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg mb-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {insights.length > 0 ? (
        <div className="space-y-3">
          {insights.map((insight, index) => (
            <div
              key={index}
              className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${getInsightColor(index)}`}>
                {getInsightIcon(index)}
              </div>
              <p className="text-sm text-foreground leading-relaxed">{insight}</p>
            </div>
          ))}
        </div>
      ) : !loading && (
        <div className="text-center py-8">
          <Sparkles className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground">{t("eda.insights.noInsights")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={generateInsights}
            className="mt-4"
          >
            <Sparkles className="w-4 h-4 mr-2" />
            {t("eda.insights.title")}
          </Button>
        </div>
      )}
    </Card>
  );
};

export default EDAInsightsSection;
