import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Trophy } from "lucide-react";

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

interface ModelResultsTableProps {
  models: ModelResult[];
  problemType: string;
  bestModelId?: string;
}

const CLASSIFICATION_METRICS = ["AUC", "F1", "Precisão", "Recall", "Acurácia"];
const REGRESSION_METRICS = ["R²", "RMSE", "MAE", "MSE"];

const ModelResultsTable = ({ models, problemType, bestModelId }: ModelResultsTableProps) => {
  const metrics = problemType === "classification" ? CLASSIFICATION_METRICS : REGRESSION_METRICS;
  const trainedModels = models.filter(m => m.status === "trained");

  const getMetricValue = (model: ModelResult, metricName: string): string => {
    const metric = model.metrics.find(m => m.metric_name === metricName);
    if (!metric) return "-";
    return metric.metric_value.toFixed(4);
  };

  const getMetricExplanation = (metricName: string): string => {
    const explanations: Record<string, string> = {
      "AUC": "Área sob a curva ROC - quanto maior (máx 1.0), melhor o modelo distingue as classes",
      "F1": "Equilíbrio entre precisão e recall - quanto maior, melhor",
      "Precisão": "Das previsões positivas, quantas estavam corretas",
      "Recall": "Dos casos positivos reais, quantos foram identificados",
      "Acurácia": "Porcentagem de previsões corretas",
      "R²": "Coeficiente de determinação - quanto mais próximo de 1, melhor o ajuste",
      "RMSE": "Erro quadrático médio - quanto menor, melhor",
      "MAE": "Erro absoluto médio - quanto menor, melhor",
      "MSE": "Erro quadrático médio ao quadrado - quanto menor, melhor",
    };
    return explanations[metricName] || "";
  };

  if (trainedModels.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        Nenhum modelo treinado ainda.
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead className="font-semibold">Modelo</TableHead>
            {metrics.map((metric) => (
              <TableHead 
                key={metric} 
                className="font-semibold text-center"
                title={getMetricExplanation(metric)}
              >
                {metric}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {trainedModels.map((model) => {
            const isBest = model.id === bestModelId;
            return (
              <TableRow 
                key={model.id}
                className={isBest ? "bg-accent/10 hover:bg-accent/20" : "hover:bg-muted/50"}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {isBest && <Trophy className="w-4 h-4 text-primary" />}
                    <span>{model.algorithm_name}</span>
                    {isBest && (
                      <Badge variant="secondary" className="text-xs">
                        Melhor
                      </Badge>
                    )}
                  </div>
                </TableCell>
                {metrics.map((metric) => (
                  <TableCell key={metric} className="text-center tabular-nums">
                    {getMetricValue(model, metric)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      
      <div className="p-3 bg-muted/30 border-t">
        <p className="text-xs text-muted-foreground">
          <strong>Dica:</strong> Passe o mouse sobre o nome da métrica para ver uma explicação simples.
        </p>
      </div>
    </div>
  );
};

export default ModelResultsTable;
