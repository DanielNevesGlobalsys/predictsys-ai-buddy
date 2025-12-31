import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Database,
  Columns,
  Hash,
  Tags,
  AlertTriangle,
  Target,
  Gauge,
  BarChart3,
  HelpCircle,
} from "lucide-react";

interface KPIData {
  totalRows: number;
  totalColumns: number;
  numericCount: number;
  categoricalCount: number;
  missingPercentage: number;
  targetColumn?: string;
  dataQualityScore: number;
  sampledRows?: number;
}

interface EDAKPICardsProps {
  data: KPIData;
}

const EDAKPICards = ({ data }: EDAKPICardsProps) => {
  const { t } = useTranslation();

  const kpis = [
    {
      id: "rows",
      icon: Database,
      label: t("eda.kpis.rows.label"),
      value: data.totalRows.toLocaleString(),
      description: t("eda.kpis.rows.description"),
      tooltip: t("eda.kpis.rows.tooltip"),
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    {
      id: "columns",
      icon: Columns,
      label: t("eda.kpis.columns.label"),
      value: data.totalColumns.toString(),
      description: t("eda.kpis.columns.description"),
      tooltip: t("eda.kpis.columns.tooltip"),
      color: "text-secondary",
      bgColor: "bg-secondary/10",
    },
    {
      id: "numeric",
      icon: Hash,
      label: t("eda.kpis.numeric.label"),
      value: data.numericCount.toString(),
      description: t("eda.kpis.numeric.description"),
      tooltip: t("eda.kpis.numeric.tooltip"),
      color: "text-chart-1",
      bgColor: "bg-chart-1/10",
    },
    {
      id: "categorical",
      icon: Tags,
      label: t("eda.kpis.categorical.label"),
      value: data.categoricalCount.toString(),
      description: t("eda.kpis.categorical.description"),
      tooltip: t("eda.kpis.categorical.tooltip"),
      color: "text-chart-2",
      bgColor: "bg-chart-2/10",
    },
    {
      id: "missing",
      icon: AlertTriangle,
      label: t("eda.kpis.missing.label"),
      value: `${data.missingPercentage.toFixed(1)}%`,
      description: t("eda.kpis.missing.description"),
      tooltip: t("eda.kpis.missing.tooltip"),
      color: data.missingPercentage > 20 ? "text-destructive" : "text-chart-3",
      bgColor: data.missingPercentage > 20 ? "bg-destructive/10" : "bg-chart-3/10",
    },
    {
      id: "quality",
      icon: Gauge,
      label: t("eda.kpis.quality.label"),
      value: `${data.dataQualityScore}/100`,
      description: t("eda.kpis.quality.description"),
      tooltip: t("eda.kpis.quality.tooltip"),
      color: data.dataQualityScore >= 70 ? "text-green-500" : data.dataQualityScore >= 40 ? "text-yellow-500" : "text-destructive",
      bgColor: data.dataQualityScore >= 70 ? "bg-green-500/10" : data.dataQualityScore >= 40 ? "bg-yellow-500/10" : "bg-destructive/10",
    },
  ];

  // Add target column KPI if available
  if (data.targetColumn) {
    kpis.splice(5, 0, {
      id: "target",
      icon: Target,
      label: t("eda.kpis.target.label"),
      value: data.targetColumn,
      description: t("eda.kpis.target.description"),
      tooltip: t("eda.kpis.target.tooltip"),
      color: "text-chart-4",
      bgColor: "bg-chart-4/10",
    });
  }

  // Add sampled rows KPI if data was sampled
  if (data.sampledRows && data.sampledRows < data.totalRows) {
    kpis.push({
      id: "sampled",
      icon: BarChart3,
      label: t("eda.kpis.sampled.label"),
      value: data.sampledRows.toLocaleString(),
      description: t("eda.kpis.sampled.description", { total: data.totalRows.toLocaleString() }),
      tooltip: t("eda.kpis.sampled.tooltip"),
      color: "text-muted-foreground",
      bgColor: "bg-muted/50",
    });
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <Card
            key={kpi.id}
            className="bg-gradient-card shadow-card p-5 relative group hover:shadow-hover transition-all duration-200 border border-border/50"
          >
            <div className="flex items-start gap-4">
              {/* Icon container */}
              <div className={`w-12 h-12 ${kpi.bgColor} rounded-xl flex items-center justify-center shrink-0`}>
                <kpi.icon className={`w-6 h-6 ${kpi.color}`} />
              </div>
              
              {/* Content */}
              <div className="flex-1 min-w-0 space-y-1">
                {/* Label with tooltip */}
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium text-muted-foreground">
                    {kpi.label}
                  </p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button className="opacity-50 hover:opacity-100 transition-opacity">
                        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <p className="text-sm">{kpi.tooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                
                {/* Value */}
                <p className={`text-xl font-bold ${kpi.color} break-words`}>
                  {kpi.value}
                </p>
                
                {/* Description */}
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {kpi.description}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </TooltipProvider>
  );
};

export default EDAKPICards;