import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  TrendingUp,
  Target,
  Crosshair,
  Eye,
  CheckCircle,
  BarChart3,
  Calculator,
  Clock,
  Activity,
} from "lucide-react";

interface ModelData {
  id: string;
  algorithm_name: string;
  is_production: boolean;
  trained_at: string | null;
  metrics: { metric_name: string; metric_value: number }[];
}

interface DashboardKPICardsProps {
  problemType: string;
  productionModel: ModelData;
  totalPredictions: number;
  lastPredictionAt: string | null;
}

const DashboardKPICards = ({
  problemType,
  productionModel,
  totalPredictions,
  lastPredictionAt,
}: DashboardKPICardsProps) => {
  const { t, i18n } = useTranslation();

  const getMetricValue = (metricName: string): number | null => {
    const metric = productionModel.metrics.find(m => m.metric_name === metricName);
    return metric?.metric_value ?? null;
  };

  const formatValue = (value: number | null, decimals = 2): string => {
    if (value === null) return "-";
    return value.toFixed(decimals);
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return "-";
    const locale = i18n.language === "en" ? "en-US" : i18n.language === "es" ? "es-ES" : "pt-BR";
    return new Date(dateStr).toLocaleDateString(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const classificationKPIs = [
    { key: "AUC", icon: TrendingUp, color: "text-primary" },
    { key: "F1", icon: Target, color: "text-accent" },
    { key: "Precision", icon: Crosshair, color: "text-secondary" },
    { key: "Recall", icon: Eye, color: "text-primary" },
    { key: "Accuracy", icon: CheckCircle, color: "text-accent" },
  ];

  const regressionKPIs = [
    { key: "R²", icon: TrendingUp, color: "text-primary" },
    { key: "RMSE", icon: Calculator, color: "text-accent" },
    { key: "MAE", icon: BarChart3, color: "text-secondary" },
    { key: "MAPE", icon: Activity, color: "text-primary" },
  ];

  const kpis = problemType === "classification" ? classificationKPIs : regressionKPIs;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      <TooltipProvider>
        {kpis.map(({ key, icon: Icon, color }) => {
          const value = getMetricValue(key);
          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <Card className="bg-gradient-card shadow-card p-4 hover:shadow-hover transition-all cursor-help">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground font-medium">{key}</p>
                      <p className="text-2xl font-bold">{formatValue(value)}</p>
                    </div>
                    <div className={`p-2 rounded-lg bg-muted/50 ${color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                  </div>
                </Card>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <p>{t(`modelDashboard.kpi.${key}.tooltip`)}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}

        {/* Total Predictions */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Card className="bg-gradient-card shadow-card p-4 hover:shadow-hover transition-all cursor-help">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground font-medium">
                    {t("modelDashboard.kpi.predictions.label")}
                  </p>
                  <p className="text-2xl font-bold">{totalPredictions.toLocaleString()}</p>
                </div>
                <div className="p-2 rounded-lg bg-muted/50 text-accent">
                  <BarChart3 className="w-5 h-5" />
                </div>
              </div>
            </Card>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p>{t("modelDashboard.kpi.predictions.tooltip")}</p>
          </TooltipContent>
        </Tooltip>

        {/* Last Training */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Card className="bg-gradient-card shadow-card p-4 hover:shadow-hover transition-all cursor-help">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground font-medium">
                    {t("modelDashboard.kpi.lastTrain.label")}
                  </p>
                  <p className="text-sm font-medium">{formatDate(productionModel.trained_at)}</p>
                </div>
                <div className="p-2 rounded-lg bg-muted/50 text-primary">
                  <Clock className="w-5 h-5" />
                </div>
              </div>
            </Card>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p>{t("modelDashboard.kpi.lastTrain.tooltip")}</p>
          </TooltipContent>
        </Tooltip>

        {/* Last Prediction */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Card className="bg-gradient-card shadow-card p-4 hover:shadow-hover transition-all cursor-help">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground font-medium">
                    {t("modelDashboard.kpi.lastPredict.label")}
                  </p>
                  <p className="text-sm font-medium">{formatDate(lastPredictionAt)}</p>
                </div>
                <div className="p-2 rounded-lg bg-muted/50 text-secondary">
                  <Activity className="w-5 h-5" />
                </div>
              </div>
            </Card>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p>{t("modelDashboard.kpi.lastPredict.tooltip")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};

export default DashboardKPICards;
