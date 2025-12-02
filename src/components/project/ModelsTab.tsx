import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cpu, Loader2, Trophy, BarChart3 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import ModelResultsTable from "@/components/training/ModelResultsTable";
import { useNavigate } from "react-router-dom";

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

interface ModelsTabProps {
  projectId: string;
  problemType: string;
}

const ModelsTab = ({ projectId, problemType }: ModelsTabProps) => {
  const navigate = useNavigate();
  const [models, setModels] = useState<ModelResult[]>([]);
  const [loading, setLoading] = useState(true);

  const primaryMetric = problemType === "classification" ? "AUC" : "R²";

  useEffect(() => {
    loadModels();
  }, [projectId]);

  const loadModels = async () => {
    setLoading(true);
    const { data: modelsData, error: modelsError } = await supabase
      .from("project_models")
      .select("*")
      .eq("project_id", projectId);

    if (modelsError) {
      console.error("Erro ao carregar modelos:", modelsError);
      setLoading(false);
      return;
    }

    if (modelsData && modelsData.length > 0) {
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
    }
    setLoading(false);
  };

  const getBestModel = () => {
    if (models.length === 0) return null;

    const trainedModels = models.filter(m => m.status === "trained");
    if (trainedModels.length === 0) return null;

    return trainedModels.reduce((best, current) => {
      const bestMetric = best.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0;
      const currentMetric = current.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0;
      return currentMetric > bestMetric ? current : best;
    });
  };

  const bestModel = getBestModel();
  const productionModel = models.find(m => m.is_production);

  if (loading) {
    return (
      <Card className="bg-gradient-card shadow-card p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </Card>
    );
  }

  if (models.length === 0) {
    return (
      <Card className="bg-gradient-card shadow-card p-8 text-center">
        <Cpu className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="font-semibold text-lg mb-2">Nenhum modelo treinado</h3>
        <p className="text-muted-foreground mb-4">
          Você ainda não treinou nenhum modelo para este projeto.
          Volte ao wizard para treinar seus modelos.
        </p>
        <Button onClick={() => navigate(`/projeto/${projectId}/wizard`)}>
          Ir para o Wizard
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="bg-gradient-card shadow-card p-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
              <Trophy className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Melhor Modelo</p>
              <p className="font-semibold">{bestModel?.algorithm_name || "-"}</p>
              {bestModel && (
                <p className="text-sm text-primary">
                  {primaryMetric}: {bestModel.metrics.find(m => m.metric_name === primaryMetric)?.metric_value.toFixed(4)}
                </p>
              )}
            </div>
          </div>
        </Card>

        <Card className="bg-gradient-card shadow-card p-6">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
              productionModel ? "bg-accent/10" : "bg-muted"
            }`}>
              <BarChart3 className={`w-6 h-6 ${productionModel ? "text-accent" : "text-muted-foreground"}`} />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Modelo em Produção</p>
              <p className="font-semibold">
                {productionModel?.algorithm_name || "Nenhum selecionado"}
              </p>
              {productionModel && (
                <p className="text-sm text-accent">
                  {primaryMetric}: {productionModel.metrics.find(m => m.metric_name === primaryMetric)?.metric_value.toFixed(4)}
                </p>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Info box */}
      <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
        <p className="text-sm text-muted-foreground">
          <strong className="text-secondary">Selecione o modelo para produção:</strong> Clique em 
          "Selecionar" ao lado do modelo que deseja usar para fazer previsões via API. 
          Apenas um modelo pode estar em produção por vez.
        </p>
      </div>

      {/* Models table */}
      <ModelResultsTable 
        models={models} 
        problemType={problemType} 
        bestModelId={bestModel?.id}
        projectId={projectId}
        allowSelectProduction={true}
        onProductionChange={loadModels}
      />
    </div>
  );
};

export default ModelsTab;
