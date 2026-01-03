import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, BarChart3, Sparkles, RefreshCw, Lightbulb, AlertTriangle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface FeatureImportance {
  feature_name: string;
  importance_value: number;
}

interface ParsedInsight {
  topFeatures: { name: string; importance: string; explanation: string }[];
  businessMeaning: string;
  recommendations: string[];
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
  const [parsedInsights, setParsedInsights] = useState<ParsedInsight | null>(null);
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
      const raw = data.shap_insights as string;
      setShapInsights(raw);
      parseInsights(raw);
    }
  };

  const parseInsights = (text: string) => {
    // Try to parse structured insights from the text
    const topFeatures = featureImportances.slice(0, 5).map(f => ({
      name: f.feature_name,
      importance: `${(f.importance_value * 100).toFixed(1)}%`,
      explanation: ""
    }));

    // Simple parsing - the AI text will be displayed in sections
    setParsedInsights({
      topFeatures,
      businessMeaning: text,
      recommendations: []
    });
  };

  const generateShapInsights = async () => {
    if (!modelId || featureImportances.length === 0) return;

    setGeneratingInsights(true);
    try {
      const topFeatures = featureImportances.slice(0, 5);
      const featureList = topFeatures.map(f => 
        `- ${f.feature_name}: ${(f.importance_value * 100).toFixed(1)}%`
      ).join("\n");

      const lang = i18n.language === 'pt' ? 'Portuguese (Brazil)' : i18n.language === 'es' ? 'Spanish' : 'English';
      
      const systemPrompt = `You are a data science expert explaining model interpretability in business language. 
Respond in ${lang}.
Structure your response with clear sections:
1. First, explain what each top variable means for predictions (2-3 sentences per variable)
2. Then, add a section "O que isso significa para o negócio" (or equivalent in the language) with 2-3 key business takeaways
3. Finally, add "Recomendações" with 2-3 actionable recommendations as bullet points

Keep explanations concise and business-focused. Avoid technical jargon.`;

      const prompt = `The model "${modelName}" (${problemType}) has the following top feature importances:

${featureList}

Please provide a structured analysis with:
1. Brief explanation of each variable's influence
2. Business implications section
3. Actionable recommendations`;

      const { data, error } = await supabase.functions.invoke("global-chat", {
        body: {
          message: prompt,
          systemPrompt,
        },
      });

      if (error) throw error;

      const insightText = data?.response || data?.text || "";
      setShapInsights(insightText);
      parseInsights(insightText);

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

  // Parse the insights text into sections
  const renderFormattedInsights = (text: string) => {
    const lines = text.split('\n').filter(line => line.trim());
    const sections: { type: 'heading' | 'bullet' | 'text'; content: string }[] = [];
    
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        sections.push({ type: 'heading', content: trimmed.replace(/\*\*/g, '') });
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.match(/^\d+\./)) {
        sections.push({ type: 'bullet', content: trimmed.replace(/^[-•]\s*/, '').replace(/^\d+\.\s*/, '') });
      } else if (trimmed) {
        sections.push({ type: 'text', content: trimmed });
      }
    });

    return (
      <div className="space-y-3">
        {sections.map((section, idx) => {
          if (section.type === 'heading') {
            return (
              <h5 key={idx} className="font-semibold text-sm text-primary flex items-center gap-2 mt-4 first:mt-0">
                {section.content.toLowerCase().includes('recomenda') || section.content.toLowerCase().includes('recommend') ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : section.content.toLowerCase().includes('negócio') || section.content.toLowerCase().includes('business') || section.content.toLowerCase().includes('significa') ? (
                  <Lightbulb className="w-4 h-4" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                {section.content}
              </h5>
            );
          } else if (section.type === 'bullet') {
            return (
              <div key={idx} className="flex items-start gap-2 text-sm pl-2">
                <span className="text-primary mt-1">•</span>
                <span className="text-muted-foreground">{section.content}</span>
              </div>
            );
          } else {
            return (
              <p key={idx} className="text-sm text-muted-foreground leading-relaxed">
                {section.content}
              </p>
            );
          }
        })}
      </div>
    );
  };

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

        {/* SHAP Insights Section - Improved Layout */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-secondary" />
              <div>
                <h4 className="font-semibold">{t("training.aiInsightsShap")}</h4>
                <p className="text-xs text-muted-foreground">
                  {i18n.language === 'pt' 
                    ? "Entenda quais variáveis mais influenciam as previsões deste modelo."
                    : i18n.language === 'es'
                    ? "Comprenda qué variables influyen más en las predicciones de este modelo."
                    : "Understand which variables most influence this model's predictions."}
                </p>
              </div>
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
            <div className="p-4 bg-secondary/5 border border-secondary/20 rounded-lg">
              {/* Top Features Summary */}
              <div className="mb-4">
                <h5 className="font-semibold text-sm text-primary flex items-center gap-2 mb-3">
                  <BarChart3 className="w-4 h-4" />
                  {i18n.language === 'pt' ? "Variáveis mais importantes" : i18n.language === 'es' ? "Variables más importantes" : "Most important variables"}
                </h5>
                <div className="space-y-2">
                  {featureImportances.slice(0, 5).map((f, idx) => (
                    <div key={f.feature_name} className="flex items-center gap-2 text-sm">
                      <span className="w-6 h-6 bg-primary/10 rounded-full flex items-center justify-center text-xs font-bold text-primary">
                        {idx + 1}
                      </span>
                      <span className="font-medium">{f.feature_name}</span>
                      <span className="text-muted-foreground">– {(f.importance_value * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* AI Analysis */}
              <div className="border-t border-secondary/20 pt-4">
                {renderFormattedInsights(shapInsights)}
              </div>
            </div>
          ) : (
            <div className="text-center py-6 bg-muted/30 rounded-lg border border-dashed border-border">
              <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {t("training.clickToGenerateShapInsights")}
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

export default TrainingInterpretability;
