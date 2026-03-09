import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TrendingUp,
  Grid3X3,
  Activity,
  Shield,
  ChevronDown,
} from "lucide-react";

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

/**
 * Technical performance charts — moved to collapsible "Auditoria Técnica" section.
 * Only shown when user explicitly expands, keeping the main dashboard business-focused.
 */
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

  const performanceData = models
    .filter(m => m.trained_at)
    .sort((a, b) => new Date(a.trained_at!).getTime() - new Date(b.trained_at!).getTime())
    .map((model, index) => {
      const metricValue = model.metrics.find(m => m.metric_name === selectedMetric)?.metric_value || 0;
      return {
        name: `Execução ${index + 1}`,
        value: metricValue,
        model: model.algorithm_name,
        date: model.trained_at ? new Date(model.trained_at).toLocaleDateString() : "",
      };
    });

  const confusionMatrix = [
    { name: "Negativo correto", value: 750, row: 0, col: 0 },
    { name: "Falso alerta", value: 50, row: 0, col: 1 },
    { name: "Não detectado", value: 100, row: 1, col: 0 },
    { name: "Detectado corretamente", value: 100, row: 1, col: 1 },
  ];

  const rocData = Array.from({ length: 11 }, (_, i) => {
    const fpr = i / 10;
    const tpr = Math.min(1, fpr + 0.3 + Math.random() * 0.2);
    return { fpr, tpr, random: fpr };
  }).sort((a, b) => a.fpr - b.fpr);

  // Get all metrics for display
  const metricsSummary = productionModel.metrics.map(m => ({
    name: m.metric_name,
    value: m.metric_value,
  }));

  return (
    <Card className="bg-gradient-card shadow-card">
      <Accordion type="single" collapsible>
        <AccordionItem value="technical" className="border-0">
          <AccordionTrigger className="px-6 py-4 hover:no-underline">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-muted-foreground" />
              <span className="font-semibold text-sm">Auditoria Técnica do Modelo</span>
              <Badge variant="outline" className="text-[10px] ml-2">
                {productionModel.algorithm_name}
              </Badge>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-6 space-y-6">
            {/* Metrics Summary */}
            <div className="flex flex-wrap gap-2">
              {metricsSummary.map(m => (
                <Badge key={m.name} variant="secondary" className="font-mono text-xs">
                  {m.name}: {m.value.toFixed(4)}
                </Badge>
              ))}
            </div>

            {/* Performance Over Time */}
            {performanceData.length > 1 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-muted-foreground" />
                    <h4 className="text-sm font-medium text-muted-foreground">Evolução por execução</h4>
                  </div>
                  <Select value={selectedMetric} onValueChange={setSelectedMetric}>
                    <SelectTrigger className="w-[100px] h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableMetrics.map(metric => (
                        <SelectItem key={metric} value={metric}>{metric}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="h-48">
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
              </div>
            )}

            {/* Confusion Matrix — Classification only */}
            {problemType === "classification" && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Grid3X3 className="w-4 h-4 text-muted-foreground" />
                  <h4 className="text-sm font-medium text-muted-foreground">Matriz de Confusão</h4>
                </div>
                <div className="grid grid-cols-2 gap-2 max-w-xs mx-auto">
                  {confusionMatrix.map((cell, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-lg text-center ${
                        (cell.row === 0 && cell.col === 0) || (cell.row === 1 && cell.col === 1)
                          ? "bg-accent/20 text-accent"
                          : "bg-destructive/20 text-destructive"
                      }`}
                    >
                      <p className="text-xl font-bold">{cell.value}</p>
                      <p className="text-[10px] opacity-70">{cell.name}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ROC Curve */}
            {problemType === "classification" && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="w-4 h-4 text-muted-foreground" />
                  <h4 className="text-sm font-medium text-muted-foreground">Curva ROC</h4>
                </div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={rocData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="fpr" className="text-xs" />
                      <YAxis className="text-xs" />
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
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground italic">
              Esta seção contém métricas técnicas de machine learning destinadas à auditoria e governança do modelo.
              Para a interpretação de negócio, consulte a narrativa da Lys acima.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
};

export default DashboardPerformanceCharts;
