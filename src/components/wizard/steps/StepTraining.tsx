import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cpu, Play, Clock, CheckCircle, Loader2, Trophy, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ProjectData } from "../WizardContainer";
import ModelResultsTable from "@/components/training/ModelResultsTable";

interface StepTrainingProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

const ALGORITHMS_CLASSIFICATION = [
  { name: "Regressão Logística", description: "Modelo linear simples e interpretável" },
  { name: "Random Forest", description: "Conjunto de árvores de decisão" },
  { name: "Gradient Boosting", description: "Boosting sequencial de árvores" },
];

const ALGORITHMS_REGRESSION = [
  { name: "Regressão Linear", description: "Modelo linear para valores contínuos" },
  { name: "Random Forest Regressor", description: "Conjunto de árvores para regressão" },
  { name: "Gradient Boosting Regressor", description: "Boosting sequencial para regressão" },
];

interface ModelResult {
  id: string;
  algorithm_name: string;
  status: string;
  is_production: boolean;
  metrics: { metric_name: string; metric_value: number }[];
}

const StepTraining = ({
  projectData,
  onNext,
  onBack,
  loading,
  saveProject,
}: StepTrainingProps) => {
  const [isTraining, setIsTraining] = useState(false);
  const [models, setModels] = useState<ModelResult[]>([]);
  const [trainingComplete, setTrainingComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const algorithms = projectData.problem_type === "classification" 
    ? ALGORITHMS_CLASSIFICATION 
    : ALGORITHMS_REGRESSION;

  const primaryMetric = projectData.problem_type === "classification" ? "AUC" : "R²";

  useEffect(() => {
    loadExistingModels();
  }, [projectData.id]);

  const loadExistingModels = async () => {
    if (!projectData.id) return;

    const { data: modelsData, error: modelsError } = await supabase
      .from("project_models")
      .select("*")
      .eq("project_id", projectData.id);

    if (modelsError) {
      console.error("Erro ao carregar modelos:", modelsError);
      return;
    }

    if (modelsData && modelsData.length > 0) {
      // Load metrics for each model
      const modelsWithMetrics = await Promise.all(
        modelsData.map(async (model) => {
          const { data: metrics } = await supabase
            .from("project_model_metrics")
            .select("metric_name, metric_value")
            .eq("project_model_id", model.id);

          return {
            id: model.id,
            algorithm_name: model.algorithm_name,
            status: model.status,
            is_production: model.is_production,
            metrics: metrics || [],
          };
        })
      );

      setModels(modelsWithMetrics);
      setTrainingComplete(modelsData.some(m => m.status === "trained"));
    }
  };

  const handleStartTraining = async () => {
    if (!projectData.id || !projectData.target_column) {
      toast.error("Configure a coluna alvo antes de treinar");
      return;
    }

    setIsTraining(true);
    setError(null);
    setModels([]);

    try {
      await saveProject({ status: "training" });

      const { data, error: fnError } = await supabase.functions.invoke("train-models", {
        body: { project_id: projectData.id },
      });

      if (fnError) {
        throw fnError;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      toast.success("Treinamento concluído com sucesso!");
      await loadExistingModels();
      setTrainingComplete(true);

    } catch (err) {
      console.error("Erro no treinamento:", err);
      const message = err instanceof Error ? err.message : "Erro ao treinar modelos";
      setError(message);
      toast.error(message);
      await saveProject({ status: "features_selected" });
    } finally {
      setIsTraining(false);
    }
  };

  const getBestModel = () => {
    if (models.length === 0) return null;

    const trainedModels = models.filter(m => m.status === "trained");
    if (trainedModels.length === 0) return null;

    return trainedModels.reduce((best, current) => {
      const bestMetric = best.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0;
      const currentMetric = current.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0;
      
      // For R² and AUC, higher is better
      return currentMetric > bestMetric ? current : best;
    });
  };

  const bestModel = getBestModel();

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Cpu className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            Treinamento de Modelos
          </h2>
          <p className="text-muted-foreground">
            O sistema vai treinar automaticamente vários algoritmos e encontrar o melhor modelo
          </p>
        </div>

        {/* Info about AutoML */}
        <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-secondary">Como funciona?</strong> A PredictSys vai treinar 
            automaticamente vários algoritmos de machine learning com seus dados e comparar 
            os resultados. Você não precisa saber programar ou conhecer os detalhes técnicos!
          </p>
        </div>

        {/* Algorithms that will be tested */}
        {!trainingComplete && (
          <div className="space-y-3">
            <h3 className="font-semibold">Algoritmos que serão testados:</h3>
            <div className="grid gap-3">
              {algorithms.map((algo) => (
                <div
                  key={algo.name}
                  className="flex items-center gap-4 p-4 bg-muted/30 rounded-lg"
                >
                  <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                    <Cpu className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium">{algo.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {algo.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Training status */}
        <div className="text-center py-8">
          {!isTraining && !trainingComplete && !error && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-muted rounded-2xl flex items-center justify-center mx-auto">
                <Clock className="w-10 h-10 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold text-lg">Pronto para treinar</p>
                <p className="text-muted-foreground">
                  Clique no botão abaixo para iniciar o treinamento. Isso pode levar alguns segundos.
                </p>
              </div>
              <Button
                size="lg"
                onClick={handleStartTraining}
                disabled={!projectData.target_column}
                className="bg-gradient-primary hover:shadow-hover transition-all"
              >
                <Play className="w-5 h-5 mr-2" />
                Treinar Modelos
              </Button>
            </div>
          )}

          {isTraining && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto">
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              </div>
              <div>
                <p className="font-semibold text-lg">Treinando modelos...</p>
                <p className="text-muted-foreground">
                  Isso pode levar alguns segundos. Por favor, aguarde.
                </p>
              </div>
            </div>
          )}

          {error && !isTraining && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-destructive/10 rounded-2xl flex items-center justify-center mx-auto">
                <AlertCircle className="w-10 h-10 text-destructive" />
              </div>
              <div>
                <p className="font-semibold text-lg text-destructive">
                  Erro no treinamento
                </p>
                <p className="text-muted-foreground">{error}</p>
              </div>
              <Button
                size="lg"
                onClick={handleStartTraining}
                className="bg-gradient-primary hover:shadow-hover transition-all"
              >
                <Play className="w-5 h-5 mr-2" />
                Tentar Novamente
              </Button>
            </div>
          )}

          {trainingComplete && !isTraining && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-accent/10 rounded-2xl flex items-center justify-center mx-auto">
                <CheckCircle className="w-10 h-10 text-accent" />
              </div>
              <div>
                <p className="font-semibold text-lg text-accent">
                  Treinamento concluído!
                </p>
                <p className="text-muted-foreground">
                  Treinamos automaticamente {models.filter(m => m.status === "trained").length} modelos para você.
                  Veja a comparação abaixo.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Results table */}
        {trainingComplete && models.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-primary" />
              <h3 className="font-semibold">Comparação de Modelos</h3>
            </div>
            
            <p className="text-sm text-muted-foreground">
              A tabela abaixo mostra as métricas de cada modelo treinado. O modelo destacado em 
              verde é o que teve o melhor desempenho na métrica principal ({primaryMetric}).
            </p>

            <ModelResultsTable 
              models={models} 
              problemType={projectData.problem_type} 
              bestModelId={bestModel?.id}
            />

            <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg">
              <p className="text-sm">
                <strong>Melhor modelo:</strong> {bestModel?.algorithm_name} com {primaryMetric} de{" "}
                <span className="font-bold text-primary">
                  {(bestModel?.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0).toFixed(4)}
                </span>
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading || isTraining}>
            Voltar
          </Button>
          <Button
            onClick={() => onNext()}
            disabled={loading || isTraining || !trainingComplete}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            Próximo
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepTraining;
