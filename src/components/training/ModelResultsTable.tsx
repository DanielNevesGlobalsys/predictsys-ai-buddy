import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Trophy, Rocket, Loader2, HelpCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

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
  projectId?: string;
  allowSelectProduction?: boolean;
  onProductionChange?: () => void;
}

const CLASSIFICATION_METRICS = ["AUC", "F1", "Precisão", "Recall", "Acurácia"];
const REGRESSION_METRICS = ["R²", "RMSE", "MAE", "MSE"];

const ModelResultsTable = ({ 
  models, 
  problemType, 
  bestModelId, 
  projectId,
  allowSelectProduction = false,
  onProductionChange 
}: ModelResultsTableProps) => {
  const { t } = useTranslation();
  const [settingProduction, setSettingProduction] = useState<string | null>(null);
  
  const metrics = problemType === "classification" ? CLASSIFICATION_METRICS : REGRESSION_METRICS;
  const trainedModels = models.filter(m => m.status === "trained");

  const getMetricExplanation = (metricName: string): string => {
    const explanations: Record<string, string> = {
      "AUC": t("models.metrics.AUC"),
      "F1": t("models.metrics.F1"),
      "Precisão": t("models.metrics.PrecisionDesc"),
      "Recall": t("models.metrics.RecallDesc"),
      "Acurácia": t("models.metrics.AccuracyDesc"),
      "MAE": t("models.metrics.MAE"),
      "MSE": t("models.metrics.MSE"),
      "RMSE": t("models.metrics.RMSE"),
      "R²": t("models.metrics.R2")
    };
    return explanations[metricName] || metricName;
  };

  const getMetricValue = (model: ModelResult, metricName: string): string => {
    const metric = model.metrics.find(m => m.metric_name === metricName);
    if (!metric) return "-";
    return metric.metric_value.toFixed(4);
  };

  const handleSetProduction = async (modelId: string) => {
    if (!projectId) return;
    
    setSettingProduction(modelId);
    try {
      // First, set all models of this project to is_production = false
      const { error: resetError } = await supabase
        .from("project_models")
        .update({ is_production: false })
        .eq("project_id", projectId);

      if (resetError) throw resetError;

      // Then set the selected model to is_production = true
      const { error: setError } = await supabase
        .from("project_models")
        .update({ is_production: true })
        .eq("id", modelId);

      if (setError) throw setError;

      // Update project status to deployed
      await supabase
        .from("projects")
        .update({ status: "deployed" })
        .eq("id", projectId);

      toast.success(t("models.productionSet"));
      onProductionChange?.();
    } catch (error) {
      console.error("Error setting production model:", error);
      toast.error(t("models.productionError"));
    } finally {
      setSettingProduction(null);
    }
  };

  if (trainedModels.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {t("models.noModelsTrained")}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="font-semibold">{t("models.table.model")}</TableHead>
              {metrics.map((metric) => (
                <TableHead 
                  key={metric} 
                  className="font-semibold text-center"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 cursor-help">
                        {metric}
                        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent 
                      side="top" 
                      className="max-w-xs text-sm"
                    >
                      <p>{getMetricExplanation(metric)}</p>
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
              ))}
              <TableHead className="font-semibold text-center">{t("models.table.status")}</TableHead>
              {allowSelectProduction && (
                <TableHead className="font-semibold text-center">{t("models.table.action")}</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {trainedModels.map((model) => {
              const isBest = model.id === bestModelId;
              const isProduction = model.is_production;
              return (
                <TableRow 
                  key={model.id}
                  className={
                    isProduction 
                      ? "bg-primary/10 hover:bg-primary/20" 
                      : isBest 
                        ? "bg-accent/10 hover:bg-accent/20" 
                        : "hover:bg-muted/50"
                  }
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {isBest && <Trophy className="w-4 h-4 text-primary" />}
                      {isProduction && <Rocket className="w-4 h-4 text-accent" />}
                      <span>{model.algorithm_name}</span>
                    </div>
                  </TableCell>
                  {metrics.map((metric) => (
                    <TableCell key={metric} className="text-center tabular-nums">
                      {getMetricValue(model, metric)}
                    </TableCell>
                  ))}
                  <TableCell className="text-center">
                    <div className="flex gap-1 justify-center">
                      {isBest && (
                        <Badge variant="secondary" className="text-xs">
                          {t("models.table.best")}
                        </Badge>
                      )}
                      {isProduction && (
                        <Badge className="text-xs bg-accent text-accent-foreground">
                          {t("models.table.production")}
                        </Badge>
                      )}
                      {!isBest && !isProduction && (
                        <Badge variant="outline" className="text-xs">
                          {t("models.table.candidate")}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  {allowSelectProduction && (
                    <TableCell className="text-center">
                      {isProduction ? (
                        <span className="text-sm text-accent font-medium">{t("models.table.active")}</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSetProduction(model.id)}
                          disabled={settingProduction !== null}
                        >
                          {settingProduction === model.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            t("models.table.select")
                          )}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        
        <div className="p-3 bg-muted/30 border-t">
          <p className="text-xs text-muted-foreground">
            <strong>{t("models.table.tip")}:</strong> {t("models.table.tipText")}
          </p>
        </div>
      </div>
    </TooltipProvider>
  );
};

export default ModelResultsTable;
