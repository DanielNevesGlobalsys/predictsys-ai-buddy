import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Sparkles, 
  TrendingUp, 
  TrendingDown,
  Target,
  BarChart3,
  MessageCircle,
  RefreshCw,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Info
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface ModelMetric {
  metric_name: string;
  metric_value: number;
}

interface FeatureImportance {
  feature_name: string;
  importance_value: number;
}

interface DeployAiInsightProps {
  projectId: string;
  productionModelId: string | null;
  productionModelName: string | null;
  problemType: "classification" | "regression";
  allModels: Array<{
    id: string;
    algorithm_name: string;
    is_production: boolean;
    metrics: ModelMetric[];
  }>;
  onOpenChat?: () => void;
}

const DeployAiInsight = ({
  projectId,
  productionModelId,
  productionModelName,
  problemType,
  allModels,
  onOpenChat
}: DeployAiInsightProps) => {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [featureImportances, setFeatureImportances] = useState<FeatureImportance[]>([]);
  const [insightText, setInsightText] = useState<string | null>(null);

  const primaryMetric = problemType === "classification" ? "AUC" : "R²";
  
  useEffect(() => {
    if (productionModelId) {
      loadFeatureImportances();
      loadInsights();
    }
  }, [productionModelId]);

  const loadFeatureImportances = async () => {
    if (!productionModelId) return;
    
    const { data } = await supabase
      .from("project_feature_importances")
      .select("feature_name, importance_value")
      .eq("project_model_id", productionModelId)
      .order("importance_value", { ascending: false })
      .limit(5);
    
    if (data) {
      setFeatureImportances(data);
    }
  };

  const loadInsights = async () => {
    if (!productionModelId) return;
    
    const { data } = await supabase
      .from("project_model_insights")
      .select("insights, shap_insights")
      .eq("model_id", productionModelId)
      .eq("language", i18n.language.substring(0, 2))
      .maybeSingle();
    
    if (data?.shap_insights) {
      const shapInsights = data.shap_insights as { text?: string };
      if (shapInsights.text) {
        setInsightText(shapInsights.text);
      }
    }
  };

  const getProductionModel = () => {
    return allModels.find(m => m.id === productionModelId);
  };

  const getMetricValue = (model: typeof allModels[0], metricName: string): number | null => {
    const metric = model.metrics.find(m => m.metric_name === metricName);
    return metric ? metric.metric_value : null;
  };

  const getModelScore = (): "strong" | "ok" | "attention" => {
    const model = getProductionModel();
    if (!model) return "attention";
    
    const primaryValue = getMetricValue(model, primaryMetric);
    if (primaryValue === null) return "attention";
    
    if (problemType === "classification") {
      if (primaryValue >= 0.85) return "strong";
      if (primaryValue >= 0.70) return "ok";
      return "attention";
    } else {
      if (primaryValue >= 0.80) return "strong";
      if (primaryValue >= 0.50) return "ok";
      return "attention";
    }
  };

  const getScoreLabel = (score: "strong" | "ok" | "attention"): string => {
    const labels = {
      strong: t("deployAi.scoreStrong", "Modelo forte"),
      ok: t("deployAi.scoreOk", "Modelo adequado"),
      attention: t("deployAi.scoreAttention", "Requer atenção")
    };
    return labels[score];
  };

  const getScoreIcon = (score: "strong" | "ok" | "attention") => {
    switch (score) {
      case "strong": return <CheckCircle className="w-5 h-5 text-green-500" />;
      case "ok": return <Info className="w-5 h-5 text-blue-500" />;
      case "attention": return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
    }
  };

  const getModelAdvantages = (): string[] => {
    const model = getProductionModel();
    if (!model) return [];
    
    const advantages: string[] = [];
    const trainedModels = allModels.filter(m => m.metrics.length > 0);
    
    if (trainedModels.length <= 1) {
      advantages.push(t("deployAi.onlyModel", "Único modelo disponível"));
      return advantages;
    }

    // Check if best on primary metric
    const modelPrimary = getMetricValue(model, primaryMetric) || 0;
    const bestPrimary = Math.max(...trainedModels.map(m => getMetricValue(m, primaryMetric) || 0));
    if (modelPrimary === bestPrimary) {
      advantages.push(t("deployAi.bestPrimary", { metric: primaryMetric, defaultValue: `Melhor ${primaryMetric} entre os candidatos` }));
    }

    // Check F1 for classification
    if (problemType === "classification") {
      const modelF1 = getMetricValue(model, "F1") || 0;
      const modelPrecision = getMetricValue(model, "Precisão") || 0;
      const modelRecall = getMetricValue(model, "Recall") || 0;
      
      if (Math.abs(modelPrecision - modelRecall) < 0.1 && modelF1 > 0.7) {
        advantages.push(t("deployAi.balancedPrecisionRecall", "Bom equilíbrio entre Precisão e Recall"));
      }
    }

    // Algorithm-specific advantages
    if (model.algorithm_name.toLowerCase().includes("random")) {
      advantages.push(t("deployAi.robustOutliers", "Robusto a outliers e dados desbalanceados"));
    } else if (model.algorithm_name.toLowerCase().includes("logistic") || model.algorithm_name.toLowerCase().includes("linear")) {
      advantages.push(t("deployAi.interpretable", "Alta interpretabilidade para stakeholders"));
    } else if (model.algorithm_name.toLowerCase().includes("gradient")) {
      advantages.push(t("deployAi.complexPatterns", "Captura padrões complexos nos dados"));
    }

    return advantages.slice(0, 3);
  };

  const generateQuickSummary = (): string => {
    const model = getProductionModel();
    if (!model) return t("deployAi.noModelSelected");
    
    const score = getModelScore();
    const primaryValue = getMetricValue(model, primaryMetric);
    const valueStr = primaryValue !== null ? (primaryValue * 100).toFixed(1) : "0";
    
    const params = { 
      model: model.algorithm_name, 
      metric: primaryMetric, 
      value: valueStr 
    };
    
    if (score === "strong") {
      return t("deployAi.summaryStrong", params);
    } else if (score === "ok") {
      return t("deployAi.summaryOk", params);
    } else {
      return t("deployAi.summaryAttention", params);
    }
  };

  const model = getProductionModel();
  const score = getModelScore();
  const advantages = getModelAdvantages();

  if (!productionModelId || !model) {
    return (
      <Card className="p-6 bg-muted/20 border-dashed">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Sparkles className="w-5 h-5" />
          <p>{t("deployAi.selectModelToSee", "Selecione um modelo para produção para ver os insights de IA.")}</p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 border-primary/20">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-primary rounded-xl flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h3 className="font-semibold text-lg">
                {t("deployAi.title", "Assistente de IA do Deploy")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("deployAi.subtitle", "Resumo das métricas e principais aprendizados do modelo selecionado")}
              </p>
            </div>
          </div>
          <Badge variant={score === "strong" ? "default" : score === "ok" ? "secondary" : "outline"} className="flex items-center gap-1.5">
            {getScoreIcon(score)}
            {getScoreLabel(score)}
          </Badge>
        </div>

        {/* Quick Summary */}
        <div className="space-y-2">
          <h4 className="font-medium flex items-center gap-2 text-sm">
            <Target className="w-4 h-4 text-primary" />
            {t("deployAi.quickSummary", "Resumo Rápido")}
          </h4>
          <p className="text-sm text-muted-foreground leading-relaxed pl-6">
            {generateQuickSummary()}
          </p>
        </div>

        {/* Why this model */}
        {advantages.length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium flex items-center gap-2 text-sm">
              <TrendingUp className="w-4 h-4 text-accent" />
              {t("deployAi.whyThisModel", "Por que esse modelo?")}
            </h4>
            <ul className="space-y-1.5 pl-6">
              {advantages.map((adv, idx) => (
                <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                  <CheckCircle className="w-3.5 h-3.5 text-accent mt-0.5 flex-shrink-0" />
                  <span>{adv}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Feature Importance */}
        {featureImportances.length > 0 && (
          <div className="space-y-3">
            <h4 className="font-medium flex items-center gap-2 text-sm">
              <BarChart3 className="w-4 h-4 text-secondary" />
              {t("deployAi.topFeatures", "Variáveis que mais influenciam")}
            </h4>
            <div className="space-y-2 pl-6">
              {featureImportances.slice(0, 5).map((feat, idx) => (
                <div key={feat.feature_name} className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-4">{idx + 1}.</span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{feat.feature_name}</span>
                      <span className="text-xs text-muted-foreground">
                        {(feat.importance_value * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-primary to-accent rounded-full transition-all"
                        style={{ width: `${Math.min(feat.importance_value * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CTA to chat */}
        {onOpenChat && (
          <div className="pt-4 border-t border-border/50">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t("deployAi.wantToKnowMore", "Quer entender melhor esses resultados?")}
              </p>
              <Button variant="outline" size="sm" onClick={onOpenChat} className="gap-2">
                <MessageCircle className="w-4 h-4" />
                {t("deployAi.askAssistant", "Perguntar ao Assistente")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};

export default DeployAiInsight;
