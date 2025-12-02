import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { 
  Rocket, 
  Globe, 
  Code, 
  Copy, 
  CheckCircle, 
  AlertCircle,
  Loader2 
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ProjectData } from "../WizardContainer";
import ModelResultsTable from "@/components/training/ModelResultsTable";

interface StepDeployProps {
  projectData: ProjectData;
  onBack: () => void;
  onComplete: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

interface ModelResult {
  id: string;
  algorithm_name: string;
  status: string;
  is_production: boolean;
  metrics: { metric_name: string; metric_value: number }[];
}

const StepDeploy = ({ projectData, onBack, onComplete, loading, saveProject }: StepDeployProps) => {
  const [copied, setCopied] = useState<string | null>(null);
  const [models, setModels] = useState<ModelResult[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [columns, setColumns] = useState<{ column_name: string }[]>([]);

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const apiEndpoint = `${supabaseUrl}/functions/v1/predict`;
  const primaryMetric = projectData.problem_type === "classification" ? "AUC" : "R²";

  useEffect(() => {
    if (projectData.id) {
      loadModels();
      loadColumns();
    }
  }, [projectData.id]);

  const loadModels = async () => {
    if (!projectData.id) return;
    setLoadingModels(true);

    const { data: modelsData } = await supabase
      .from("project_models")
      .select("*")
      .eq("project_id", projectData.id);

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
    setLoadingModels(false);
  };

  const loadColumns = async () => {
    if (!projectData.id) return;

    const { data: cols } = await supabase
      .from("project_columns")
      .select("column_name, inferred_type")
      .eq("project_id", projectData.id)
      .order("column_index");

    if (cols) {
      setColumns(
        cols
          .filter(c => c.column_name !== projectData.target_column && c.inferred_type === "numerico")
          .map(c => ({ column_name: c.column_name }))
      );
    }
  };

  const getBestModel = () => {
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

  const generateExampleFeatures = () => {
    const features: Record<string, number> = {};
    columns.forEach(col => {
      features[col.column_name] = Math.round(Math.random() * 100);
    });
    return features;
  };

  const exampleFeatures = generateExampleFeatures();

  const curlExample = `curl -X POST "${apiEndpoint}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "project_id": "${projectData.id}",
    "features": ${JSON.stringify(exampleFeatures, null, 4).split('\n').join('\n    ')}
  }'`;

  const handleCopy = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleComplete = async () => {
    if (productionModel) {
      await saveProject({ status: "deployed" });
    }
    onComplete();
  };

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Rocket className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            Deploy e API
          </h2>
          <p className="text-muted-foreground">
            Selecione o modelo para produção e veja como usar a API
          </p>
        </div>

        {/* Info about deployment */}
        <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-accent">O que é o Deploy?</strong> Quando você faz o deploy, 
            seu modelo fica disponível para fazer previsões em tempo real. Você pode integrar 
            com seus sistemas existentes através de uma API simples.
          </p>
        </div>

        {/* Model selection */}
        {loadingModels ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : models.length === 0 ? (
          <div className="text-center py-8">
            <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">
              Nenhum modelo treinado. Volte ao passo anterior para treinar os modelos.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Selecione o Modelo para Produção</h3>
              {productionModel && (
                <span className="text-sm text-accent flex items-center gap-1">
                  <CheckCircle className="w-4 h-4" />
                  Modelo selecionado
                </span>
              )}
            </div>

            <ModelResultsTable
              models={models}
              problemType={projectData.problem_type}
              bestModelId={bestModel?.id}
              projectId={projectData.id}
              allowSelectProduction={true}
              onProductionChange={loadModels}
            />
          </div>
        )}

        {/* API info - only show if production model is selected */}
        {productionModel && (
          <>
            {/* API Endpoint */}
            <div className="space-y-3">
              <h3 className="font-semibold flex items-center gap-2">
                <Globe className="w-4 h-4 text-primary" />
                Endpoint da API
              </h3>
              <div className="bg-muted/30 rounded-xl p-4 flex items-center justify-between">
                <code className="text-sm text-primary break-all">POST {apiEndpoint}</code>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => handleCopy(apiEndpoint, "endpoint")}
                >
                  {copied === "endpoint" ? (
                    <CheckCircle className="w-4 h-4 text-accent" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Example request */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold flex items-center gap-2">
                  <Code className="w-4 h-4 text-secondary" />
                  Exemplo de Requisição
                </h3>
                <Button variant="ghost" size="sm" onClick={() => handleCopy(curlExample, "curl")}>
                  {copied === "curl" ? (
                    <>
                      <CheckCircle className="w-4 h-4 mr-1 text-accent" />
                      Copiado!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-1" />
                      Copiar
                    </>
                  )}
                </Button>
              </div>
              <div className="bg-foreground/5 rounded-xl p-4 overflow-x-auto">
                <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-mono">
                  {curlExample}
                </pre>
              </div>
            </div>

            {/* Example response */}
            <div className="space-y-3">
              <h3 className="font-semibold">Exemplo de Resposta</h3>
              <div className="bg-foreground/5 rounded-xl p-4">
                <pre className="text-sm text-muted-foreground font-mono">
{projectData.problem_type === "classification" 
  ? `{
  "classe_prevista": 1,
  "probabilidade": 0.87,
  "modelo": "${productionModel.algorithm_name}",
  "timestamp": "${new Date().toISOString()}"
}`
  : `{
  "valor_previsto": 1523.45,
  "modelo": "${productionModel.algorithm_name}",
  "timestamp": "${new Date().toISOString()}"
}`}
                </pre>
              </div>
            </div>
          </>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            Voltar
          </Button>
          <Button
            onClick={handleComplete}
            disabled={loading || !productionModel}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {loading ? "Finalizando..." : "Concluir Projeto"}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDeploy;
