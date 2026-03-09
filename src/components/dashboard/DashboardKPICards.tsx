import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Users,
  ShieldAlert,
  DollarSign,
  Clock,
  Activity,
  TrendingUp,
  BarChart3,
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

/**
 * Business-oriented KPI translations.
 * Maps raw ML metrics to executive-friendly labels.
 */
const getBusinessMetric = (
  metrics: { metric_name: string; metric_value: number }[],
  metricName: string
): number | null => {
  const m = metrics.find(m => m.metric_name === metricName);
  return m?.metric_value ?? null;
};

const DashboardKPICards = ({
  problemType,
  productionModel,
  totalPredictions,
  lastPredictionAt,
}: DashboardKPICardsProps) => {
  const { i18n } = useTranslation();

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return "—";
    const locale = i18n.language === "en" ? "en-US" : i18n.language === "es" ? "es-ES" : "pt-BR";
    return new Date(dateStr).toLocaleDateString(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  // Translate ML metrics into business KPIs
  const auc = getBusinessMetric(productionModel.metrics, "AUC");
  const f1 = getBusinessMetric(productionModel.metrics, "F1");
  const recall = getBusinessMetric(productionModel.metrics, "Recall");
  const r2 = getBusinessMetric(productionModel.metrics, "R²");

  const isClassification = problemType === "classification";

  // Business KPI: detection capability (based on AUC or R²)
  const detectionCapability = isClassification
    ? auc != null ? Math.round(auc * 100) : null
    : r2 != null ? Math.round(r2 * 100) : null;

  // Business KPI: event capture rate (based on Recall)
  const captureRate = recall != null ? Math.round(recall * 100) : null;

  // Business KPI: prediction reliability (based on F1 or R²)
  const reliability = isClassification
    ? f1 != null ? Math.round(f1 * 100) : null
    : r2 != null ? Math.round(Math.max(0, r2) * 100) : null;

  const businessKPIs = [
    {
      label: isClassification
        ? "Capacidade de Detecção"
        : "Poder Preditivo",
      tooltip: isClassification
        ? "Capacidade do modelo de distinguir corretamente entre os cenários previstos"
        : "Quanto da variabilidade dos resultados o modelo consegue explicar",
      value: detectionCapability != null ? `${detectionCapability}%` : "—",
      icon: ShieldAlert,
      colorClass: "text-primary",
    },
    {
      label: isClassification
        ? "Captura de Eventos"
        : "Confiabilidade",
      tooltip: isClassification
        ? "Percentual dos eventos reais que o modelo consegue identificar"
        : "Consistência das previsões do modelo em relação aos resultados reais",
      value: captureRate != null ? `${captureRate}%` : (reliability != null ? `${reliability}%` : "—"),
      icon: TrendingUp,
      colorClass: "text-accent",
    },
    {
      label: "Confiabilidade Geral",
      tooltip: "Equilíbrio entre detectar eventos corretamente e evitar falsos alertas",
      value: reliability != null ? `${reliability}%` : "—",
      icon: Activity,
      colorClass: "text-secondary",
    },
    {
      label: "Entidades Analisadas",
      tooltip: "Total de entidades que receberam previsões do modelo",
      value: totalPredictions > 0 ? totalPredictions.toLocaleString() : "—",
      icon: Users,
      colorClass: "text-primary",
    },
    {
      label: "Último Treinamento",
      tooltip: "Data do último treinamento do modelo em produção",
      value: formatDate(productionModel.trained_at),
      icon: Clock,
      colorClass: "text-muted-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      <TooltipProvider>
        {businessKPIs.map(({ label, tooltip, value, icon: Icon, colorClass }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Card className="bg-gradient-card shadow-card p-4 hover:shadow-hover transition-all cursor-help">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground font-medium leading-tight">{label}</p>
                    <p className="text-2xl font-bold">{value}</p>
                  </div>
                  <div className={`p-2 rounded-lg bg-muted/50 ${colorClass}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                </div>
              </Card>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p className="text-sm">{tooltip}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </TooltipProvider>
    </div>
  );
};

export default DashboardKPICards;
