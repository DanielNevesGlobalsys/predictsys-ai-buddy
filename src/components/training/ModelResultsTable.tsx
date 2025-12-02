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

const METRIC_EXPLANATIONS: Record<string, string> = {
  // Classificação
  "AUC": "Mede quão bem o modelo consegue separar quem vai churnar de quem não vai, em todos os limiares possíveis. Vai de 0 a 1: quanto mais perto de 1, melhor. É uma boa métrica quando os dados são desbalanceados (poucos churns).",
  "F1": "É a média harmônica entre Precisão e Recall. Resume, em um número só, o equilíbrio entre: quantos churns previstos são realmente churns (Precisão) e quantos churns reais o modelo conseguiu encontrar (Recall).",
  "Precisão": "Entre todos os clientes que o modelo disse que vão churnar, qual porcentagem de fato churnou. Útil quando o custo de acionar alguém que não vai churnar é alto.",
  "Recall": "Entre todos os clientes que realmente churnaram, qual porcentagem o modelo conseguiu identificar como churn. Útil quando é muito importante NÃO deixar churns passarem despercebidos.",
  "Acurácia": "Porcentagem total de acertos do modelo, considerando churn e não churn. Pode ser enganosa se a base for muito desbalanceada (quase ninguém churnando).",
  // Regressão
  "MAE": "Média da diferença absoluta entre o valor previsto e o valor real. Diz, em média, quanto o modelo erra para mais ou para menos, na mesma unidade da variável alvo.",
  "MSE": "Média dos erros ao quadrado. Penaliza mais fortemente erros grandes. Útil para comparar modelos, mas não é tão intuitivo para o negócio.",
  "RMSE": "Raiz quadrada do MSE. Fica na mesma unidade da variável alvo e também penaliza bastante os grandes erros.",
  "R²": "Mede o quanto o modelo explica da variação do alvo (de 0 a 1). Quanto mais próximo de 1, mais o modelo explica o comportamento da variável.",
};

const ModelResultsTable = ({ 
  models, 
  problemType, 
  bestModelId, 
  projectId,
  allowSelectProduction = false,
  onProductionChange 
}: ModelResultsTableProps) => {
  const [settingProduction, setSettingProduction] = useState<string | null>(null);
  
  const metrics = problemType === "classification" ? CLASSIFICATION_METRICS : REGRESSION_METRICS;
  const trainedModels = models.filter(m => m.status === "trained");

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

      toast.success("Modelo definido como produção!");
      onProductionChange?.();
    } catch (error) {
      console.error("Erro ao definir modelo de produção:", error);
      toast.error("Erro ao definir modelo de produção");
    } finally {
      setSettingProduction(null);
    }
  };

  if (trainedModels.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        Nenhum modelo treinado ainda.
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="font-semibold">Modelo</TableHead>
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
                      <p>{METRIC_EXPLANATIONS[metric]}</p>
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
              ))}
              {allowSelectProduction && (
                <TableHead className="font-semibold text-center">Produção</TableHead>
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
                      <div className="flex gap-1">
                        {isBest && (
                          <Badge variant="secondary" className="text-xs">
                            Melhor
                          </Badge>
                        )}
                        {isProduction && (
                          <Badge className="text-xs bg-accent text-accent-foreground">
                            Produção
                          </Badge>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  {metrics.map((metric) => (
                    <TableCell key={metric} className="text-center tabular-nums">
                      {getMetricValue(model, metric)}
                    </TableCell>
                  ))}
                  {allowSelectProduction && (
                    <TableCell className="text-center">
                      {isProduction ? (
                        <span className="text-sm text-accent font-medium">Ativo</span>
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
                            "Selecionar"
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
            <strong>Dica:</strong> Passe o mouse sobre o nome da métrica para ver uma explicação simples.
            {allowSelectProduction && " Clique em 'Selecionar' para colocar um modelo em produção."}
          </p>
        </div>
      </div>
    </TooltipProvider>
  );
};

export default ModelResultsTable;
