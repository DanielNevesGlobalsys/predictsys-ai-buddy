import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trophy, Rocket, TrendingUp, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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

interface ModelSummaryCardsProps {
  bestModel: ModelResult | null;
  productionModel: ModelResult | undefined;
  primaryMetric: string;
  problemType: string;
}

const ModelSummaryCards = ({
  bestModel,
  productionModel,
  primaryMetric,
  problemType
}: ModelSummaryCardsProps) => {
  const { t } = useTranslation();

  const getBestModelExplanation = () => {
    if (!bestModel) return "";
    const metricValue = bestModel.metrics.find(m => m.metric_name === primaryMetric)?.metric_value;
    
    if (problemType === "classification") {
      return t("models.summary.bestExplanationClassification", {
        metric: primaryMetric,
        value: metricValue?.toFixed(4) || "N/A"
      });
    } else {
      return t("models.summary.bestExplanationRegression", {
        metric: primaryMetric,
        value: metricValue?.toFixed(4) || "N/A"
      });
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="grid md:grid-cols-2 gap-4">
        {/* Best Model Card */}
        <Card className="bg-gradient-card shadow-card p-6 border-primary/30">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center shrink-0">
              <Trophy className="w-6 h-6 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-sm text-muted-foreground">{t("models.summary.bestModel")}</p>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="w-3.5 h-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-sm">{t("models.summary.bestModelTooltip")}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <p className="font-semibold text-lg truncate">{bestModel?.algorithm_name || "-"}</p>
              {bestModel && (
                <>
                  <div className="flex items-center gap-2 mt-2">
                    <Badge variant="secondary" className="text-xs">
                      {primaryMetric}: {bestModel.metrics.find(m => m.metric_name === primaryMetric)?.metric_value.toFixed(4)}
                    </Badge>
                    <TrendingUp className="w-4 h-4 text-green-500" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {getBestModelExplanation()}
                  </p>
                </>
              )}
            </div>
          </div>
        </Card>

        {/* Production Model Card */}
        <Card className={`bg-gradient-card shadow-card p-6 ${
          productionModel ? "border-accent/30" : "border-muted"
        }`}>
          <div className="flex items-start gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
              productionModel ? "bg-accent/10" : "bg-muted"
            }`}>
              <Rocket className={`w-6 h-6 ${productionModel ? "text-accent" : "text-muted-foreground"}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-sm text-muted-foreground">{t("models.summary.productionModel")}</p>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="w-3.5 h-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-sm">{t("models.summary.productionModelTooltip")}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <p className="font-semibold text-lg truncate">
                {productionModel?.algorithm_name || t("models.summary.noProductionModel")}
              </p>
              {productionModel && (
                <div className="flex items-center gap-2 mt-2">
                  <Badge className="text-xs bg-accent text-accent-foreground">
                    {primaryMetric}: {productionModel.metrics.find(m => m.metric_name === primaryMetric)?.metric_value.toFixed(4)}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {t("models.summary.active")}
                  </Badge>
                </div>
              )}
              {!productionModel && (
                <p className="text-xs text-muted-foreground mt-2">
                  {t("models.summary.selectProductionHint")}
                </p>
              )}
            </div>
          </div>
        </Card>
      </div>
    </TooltipProvider>
  );
};

export default ModelSummaryCards;
