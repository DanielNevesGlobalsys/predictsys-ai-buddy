import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import { TrendingUp, Grid3X3, Activity } from "lucide-react";

interface ModelData {
  id: string;
  algorithm_name: string;
  is_production: boolean;
  trained_at: string | null;
  metrics: { metric_name: string; metric_value: number }[];
}

interface DashboardPerformanceChartsProps {
  problemType: string;
  models: ModelData[];
  productionModel: ModelData;
}

const DashboardPerformanceCharts = ({
  problemType,
  models,
  productionModel,
}: DashboardPerformanceChartsProps) => {
  const { t } = useTranslation();
  const [selectedMetric, setSelectedMetric] = useState(
    problemType === "classification" ? "AUC" : "R²"
  );

  const classificationMetrics = ["AUC", "F1", "Accuracy", "Precision", "Recall"];
  const regressionMetrics = ["R²", "RMSE", "MAE"];
  const availableMetrics = problemType === "classification" ? classificationMetrics : regressionMetrics;

  // Prepare data for performance over time chart
  const performanceData = models
    .filter(m => m.trained_at)
    .sort((a, b) => new Date(a.trained_at!).getTime() - new Date(b.trained_at!).getTime())
    .map((model, index) => {
      const metricValue = model.metrics.find(m => m.metric_name === selectedMetric)?.metric_value || 0;
      return {
        name: `Run ${index + 1}`,
        value: metricValue,
        model: model.algorithm_name,
        date: model.trained_at ? new Date(model.trained_at).toLocaleDateString() : "",
      };
    });

  // Prepare confusion matrix data (simulated for visualization)
  const confusionMatrix = [
    { name: "TN", value: 750, row: 0, col: 0 },
    { name: "FP", value: 50, row: 0, col: 1 },
    { name: "FN", value: 100, row: 1, col: 0 },
    { name: "TP", value: 100, row: 1, col: 1 },
  ];

  // ROC curve data (simulated)
  const rocData = Array.from({ length: 11 }, (_, i) => {
    const fpr = i / 10;
    const tpr = Math.min(1, fpr + 0.3 + Math.random() * 0.2);
    return { fpr, tpr, random: fpr };
  }).sort((a, b) => a.fpr - b.fpr);

  // Gains/Lift curve data (simulated)
  const gainsData = Array.from({ length: 11 }, (_, i) => {
    const percentile = i * 10;
    const model = Math.min(100, percentile * 1.5 + Math.random() * 10);
    const random = percentile;
    return { percentile, model: Math.min(100, model), random };
  });

  return (
    <div className="space-y-6">
      {/* Performance Over Time */}
      <Card className="bg-gradient-card shadow-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">{t("modelDashboard.charts.performanceOverTime")}</h3>
          </div>
          <Select value={selectedMetric} onValueChange={setSelectedMetric}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableMetrics.map(metric => (
                <SelectItem key={metric} value={metric}>{metric}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={performanceData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="name" className="text-xs" />
              <YAxis domain={[0, 1]} className="text-xs" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={{ fill: "hsl(var(--primary))" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Classification-specific charts */}
      {problemType === "classification" && (
        <div className="grid md:grid-cols-2 gap-6">
          {/* Confusion Matrix */}
          <Card className="bg-gradient-card shadow-card p-6">
            <div className="flex items-center gap-2 mb-4">
              <Grid3X3 className="w-5 h-5 text-accent" />
              <h3 className="font-semibold">{t("modelDashboard.charts.confusionMatrix")}</h3>
            </div>
            <div className="grid grid-cols-2 gap-2 max-w-xs mx-auto">
              {confusionMatrix.map((cell, idx) => (
                <div
                  key={idx}
                  className={`p-4 rounded-lg text-center ${
                    (cell.row === 0 && cell.col === 0) || (cell.row === 1 && cell.col === 1)
                      ? "bg-accent/20 text-accent"
                      : "bg-destructive/20 text-destructive"
                  }`}
                >
                  <p className="text-2xl font-bold">{cell.value}</p>
                  <p className="text-xs opacity-70">{cell.name}</p>
                </div>
              ))}
            </div>
            <div className="flex justify-center gap-4 mt-4 text-xs text-muted-foreground">
              <span>{t("modelDashboard.charts.predicted")} →</span>
            </div>
          </Card>

          {/* ROC & Precision-Recall */}
          <Card className="bg-gradient-card shadow-card p-6">
            <Tabs defaultValue="roc" className="w-full">
              <div className="flex items-center justify-between mb-4">
                <Activity className="w-5 h-5 text-secondary" />
                <TabsList className="bg-muted/50">
                  <TabsTrigger value="roc">{t("modelDashboard.charts.rocCurve")}</TabsTrigger>
                  <TabsTrigger value="pr">{t("modelDashboard.charts.prCurve")}</TabsTrigger>
                </TabsList>
              </div>
              
              <TabsContent value="roc" className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={rocData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="fpr" label={{ value: "FPR", position: "bottom" }} className="text-xs" />
                    <YAxis label={{ value: "TPR", angle: -90, position: "left" }} className="text-xs" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="tpr"
                      stroke="hsl(var(--primary))"
                      fill="hsl(var(--primary) / 0.2)"
                    />
                    <Line type="linear" dataKey="random" stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                  </AreaChart>
                </ResponsiveContainer>
              </TabsContent>
              
              <TabsContent value="pr" className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={rocData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="fpr" label={{ value: "Recall", position: "bottom" }} className="text-xs" />
                    <YAxis label={{ value: "Precision", angle: -90, position: "left" }} className="text-xs" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="tpr"
                      stroke="hsl(var(--accent))"
                      fill="hsl(var(--accent) / 0.2)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </TabsContent>
            </Tabs>
          </Card>
        </div>
      )}

      {/* Gains/Lift Chart - Classification only */}
      {problemType === "classification" && (
        <Card className="bg-gradient-card shadow-card p-6">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">{t("modelDashboard.charts.gainsLift")}</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t("modelDashboard.charts.gainsLiftDesc")}
          </p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={gainsData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="percentile" label={{ value: "% Base", position: "bottom" }} className="text-xs" />
                <YAxis label={{ value: "% Positivos", angle: -90, position: "left" }} className="text-xs" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="model"
                  stroke="hsl(var(--primary))"
                  fill="hsl(var(--primary) / 0.2)"
                  name={t("modelDashboard.charts.model")}
                />
                <Line
                  type="linear"
                  dataKey="random"
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="5 5"
                  name={t("modelDashboard.charts.random")}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
    </div>
  );
};

export default DashboardPerformanceCharts;
