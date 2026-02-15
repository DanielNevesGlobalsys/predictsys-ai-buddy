import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Rocket, Globe, Code, Copy, CheckCircle, AlertCircle,
  Loader2, ArrowLeft, ArrowRight
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { ProjectData } from "../WizardContainer";
import ModelResultsTable from "@/components/training/ModelResultsTable";
import DeployAiInsight from "@/components/deploy/DeployAiInsight";
import DeployPanel from "./DeployPanel";

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
  hyperparameters?: Record<string, any>;
}

const StepDeploy = ({ projectData, onBack, onComplete, loading, saveProject }: StepDeployProps) => {
  const { t } = useTranslation();
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
      .from("project_models").select("*").eq("project_id", projectData.id);
    if (modelsData && modelsData.length > 0) {
      const modelsWithMetrics = await Promise.all(
        modelsData.map(async (model) => {
          const { data: metrics } = await supabase
            .from("project_model_metrics").select("metric_name, metric_value")
            .eq("project_model_id", model.id);
          return {
            id: model.id,
            algorithm_name: model.algorithm_name,
            status: model.status,
            is_production: model.is_production,
            metrics: metrics || [],
            hyperparameters: (model.hyperparameters || {}) as Record<string, any>,
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
      .from("project_columns").select("column_name, inferred_type")
      .eq("project_id", projectData.id).order("column_index");
    if (cols) {
      setColumns(cols.filter(c => c.column_name !== projectData.target_column && c.inferred_type === "numerico").map(c => ({ column_name: c.column_name })));
    }
  };

  // Build champion info from trained models
  const getChampionInfo = () => {
    const trainedModels = models.filter(m => m.status === "trained");
    if (trainedModels.length === 0) return null;

    // Find the model marked as champion (is_production or best score)
    const champion = trainedModels.find(m => m.is_production) || trainedModels.reduce((best, current) => {
      const bestMetric = best.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0;
      const currentMetric = current.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0;
      return currentMetric > bestMetric ? current : best;
    });

    const hyper = champion.hyperparameters || {};
    const metricsProfile = hyper.metrics_profile || {};
    const pMetric = metricsProfile.primary || primaryMetric;
    const score = champion.metrics.find(m => m.metric_name === pMetric)?.metric_value
      ?? champion.metrics.find(m => m.metric_name === primaryMetric)?.metric_value ?? 0;

    return {
      model_id: champion.id,
      name: champion.algorithm_name,
      score,
      primary_metric: pMetric,
      quality_flag: hyper.model_quality_flag || "ok",
      calibration: hyper.calibration || undefined,
      recommended_threshold: hyper.recommended_threshold ?? undefined,
    };
  };

  const championInfo = getChampionInfo();
  const productionModel = models.find(m => m.is_production);

  const generateExampleFeatures = () => {
    const features: Record<string, number> = {};
    columns.forEach(col => { features[col.column_name] = Math.round(Math.random() * 100); });
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

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Rocket className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">{t("stepDeploy.title")}</h2>
          <p className="text-muted-foreground">{t("stepDeploy.subtitle")}</p>
        </div>

        {/* Info */}
        <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-accent">{t("stepDeploy.whatIsDeploy")}</strong> {t("stepDeploy.whatIsDeployDesc")}
          </p>
        </div>

        {/* Deploy Panel v2 */}
        {!loadingModels && projectData.id && (
          <DeployPanel
            projectId={projectData.id}
            problemType={projectData.problem_type}
            champion={championInfo}
            onDeploySuccess={loadModels}
          />
        )}

        {/* Model table */}
        {loadingModels ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : models.length === 0 ? (
          <div className="text-center py-8">
            <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">{t("stepDeploy.noModels")}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{t("stepDeploy.selectProductionModel")}</h3>
              {productionModel && (
                <span className="text-sm text-accent flex items-center gap-1">
                  <CheckCircle className="w-4 h-4" />
                  {t("stepDeploy.modelSelected")}
                </span>
              )}
            </div>
            <ModelResultsTable
              models={models} problemType={projectData.problem_type}
              bestModelId={championInfo?.model_id} projectId={projectData.id}
              allowSelectProduction={true} onProductionChange={loadModels}
            />
          </div>
        )}

        {/* API info */}
        {productionModel && (
          <>
            <div className="space-y-3">
              <h3 className="font-semibold flex items-center gap-2">
                <Globe className="w-4 h-4 text-primary" />
                {t("stepDeploy.apiEndpoint")}
              </h3>
              <div className="bg-muted/30 rounded-xl p-4 flex items-center justify-between">
                <code className="text-sm text-primary break-all">POST {apiEndpoint}</code>
                <Button variant="ghost" size="sm" onClick={() => handleCopy(apiEndpoint, "endpoint")}>
                  {copied === "endpoint" ? <CheckCircle className="w-4 h-4 text-accent" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold flex items-center gap-2">
                  <Code className="w-4 h-4 text-secondary" />
                  {t("stepDeploy.exampleRequest")}
                </h3>
                <Button variant="ghost" size="sm" onClick={() => handleCopy(curlExample, "curl")}>
                  {copied === "curl" ? <><CheckCircle className="w-4 h-4 mr-1 text-accent" />{t("stepDeploy.copied")}</> : <><Copy className="w-4 h-4 mr-1" />{t("stepDeploy.copy")}</>}
                </Button>
              </div>
              <div className="bg-foreground/5 rounded-xl p-4 overflow-x-auto">
                <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-mono">{curlExample}</pre>
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="font-semibold">{t("stepDeploy.exampleResponse")}</h3>
              <div className="bg-foreground/5 rounded-xl p-4">
                <pre className="text-sm text-muted-foreground font-mono">
{projectData.problem_type === "classification" 
  ? `{\n  "predicted_class": 1,\n  "probability": 0.87,\n  "model": "${productionModel.algorithm_name}"\n}`
  : `{\n  "predicted_value": 1523.45,\n  "model": "${productionModel.algorithm_name}"\n}`}
                </pre>
              </div>
            </div>

            <DeployAiInsight
              projectId={projectData.id!} productionModelId={productionModel.id}
              productionModelName={productionModel.algorithm_name}
              problemType={projectData.problem_type} allModels={models}
            />
          </>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            <ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}
          </Button>
          <Button
            onClick={onComplete}
            disabled={loading || !productionModel}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {t("common.next")}<ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDeploy;
