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
  Cpu,
  BarChart3
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PredictionScheduler from "./PredictionScheduler";
interface ProjectColumn {
  column_name: string;
  inferred_type: string;
}

interface ProductionModel {
  id: string;
  algorithm_name: string;
  problem_type: string;
  trained_at: string;
  metrics: { metric_name: string; metric_value: number }[];
}

interface APIDeployTabProps {
  projectId: string;
  problemType: string;
  targetColumn?: string | null;
}

const APIDeployTab = ({ projectId, problemType, targetColumn }: APIDeployTabProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [productionModel, setProductionModel] = useState<ProductionModel | null>(null);
  const [columns, setColumns] = useState<ProjectColumn[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const apiEndpoint = `${supabaseUrl}/functions/v1/predict`;

  const primaryMetric = problemType === "classification" ? "AUC" : "R²";

  useEffect(() => {
    loadData();
  }, [projectId]);

  const loadData = async () => {
    setLoading(true);

    // Load production model
    const { data: model } = await supabase
      .from("project_models")
      .select("*")
      .eq("project_id", projectId)
      .eq("is_production", true)
      .single();

    if (model) {
      const { data: metrics } = await supabase
        .from("project_model_metrics")
        .select("metric_name, metric_value")
        .eq("project_model_id", model.id);

      setProductionModel({
        id: model.id,
        algorithm_name: model.algorithm_name,
        problem_type: model.problem_type,
        trained_at: model.trained_at,
        metrics: metrics || [],
      });
    }

    // Load columns
    const { data: cols } = await supabase
      .from("project_columns")
      .select("column_name, inferred_type")
      .eq("project_id", projectId)
      .order("column_index");

    if (cols) {
      setColumns(cols.filter(c => c.column_name !== targetColumn && c.inferred_type === "numerico"));
    }

    setLoading(false);
  };

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
    "project_id": "${projectId}",
    "features": ${JSON.stringify(exampleFeatures, null, 4).split('\n').join('\n    ')}
  }'`;

  const jsonExample = {
    project_id: projectId,
    features: exampleFeatures,
  };

  const responseExample = problemType === "classification"
    ? {
        classe_prevista: 1,
        probabilidade: 0.87,
        modelo: productionModel?.algorithm_name || "Random Forest",
        timestamp: new Date().toISOString(),
      }
    : {
        valor_previsto: 1523.45,
        modelo: productionModel?.algorithm_name || "Random Forest Regressor",
        timestamp: new Date().toISOString(),
      };

  const handleCopy = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading) {
    return (
      <Card className="bg-gradient-card shadow-card p-8 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </Card>
    );
  }

  if (!productionModel) {
    return (
      <div className="space-y-6">
        <Card className="bg-gradient-card shadow-card p-8 text-center">
          <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="font-semibold text-lg mb-2">{t("deploy.noModel.title")}</h3>
          <p className="text-muted-foreground mb-4">
            {t("deploy.noModel.description")}
          </p>
          <Button onClick={() => navigate(`/projeto/${projectId}?tab=models`)}>
            {t("deploy.noModel.goToModels")}
          </Button>
        </Card>
        
        {/* Scheduler section even without model */}
        <PredictionScheduler projectId={projectId} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Model in production */}
      <Card className="bg-gradient-card shadow-card p-6">
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <Rocket className="w-5 h-5 text-accent" />
          {t("deploy.productionModel.title")}
        </h3>
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">{t("deploy.productionModel.algorithm")}</p>
            <p className="font-medium">{productionModel.algorithm_name}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("deploy.productionModel.type")}</p>
            <p className="font-medium">
              {productionModel.problem_type === "classification" 
                ? t("project.classification") 
                : t("project.regression")}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{primaryMetric}</p>
            <p className="font-medium text-accent">
              {productionModel.metrics.find(m => m.metric_name === primaryMetric)?.metric_value.toFixed(4) || "-"}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("deploy.productionModel.trainedAt")}</p>
            <p className="font-medium">
              {productionModel.trained_at 
                ? new Date(productionModel.trained_at).toLocaleDateString()
                : "-"}
            </p>
          </div>
        </div>
      </Card>

      {/* API Endpoint */}
      <Card className="bg-gradient-card shadow-card p-6">
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <Globe className="w-5 h-5 text-primary" />
          {t("deploy.endpoint.title")}
        </h3>
        <div className="bg-muted/30 rounded-xl p-4 flex items-center justify-between gap-4">
          <code className="text-sm text-primary break-all flex-1">
            POST {apiEndpoint}
          </code>
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
      </Card>

      {/* Info box */}
      <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
        <p className="text-sm text-muted-foreground">
          <strong className="text-secondary">{t("deploy.howToUse.title")}</strong> {t("deploy.howToUse.description")}
        </p>
      </div>

      {/* Required features */}
      <Card className="bg-gradient-card shadow-card p-6">
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <Cpu className="w-5 h-5 text-secondary" />
          {t("deploy.requiredFeatures.title")}
        </h3>
        <div className="bg-muted/30 rounded-xl p-4">
          <div className="flex flex-wrap gap-2">
            {columns.map(col => (
              <span 
                key={col.column_name}
                className="px-3 py-1 bg-background rounded-full text-sm font-mono"
              >
                {col.column_name}
              </span>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          {t("deploy.requiredFeatures.note")}
        </p>
      </Card>

      {/* cURL example */}
      <Card className="bg-gradient-card shadow-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Code className="w-5 h-5 text-primary" />
            {t("deploy.curlExample.title")}
          </h3>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => handleCopy(curlExample, "curl")}
          >
            {copied === "curl" ? (
              <>
                <CheckCircle className="w-4 h-4 mr-1 text-accent" />
                {t("deploy.copied")}
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-1" />
                {t("deploy.copy")}
              </>
            )}
          </Button>
        </div>
        <div className="bg-foreground/5 rounded-xl p-4 overflow-x-auto">
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-mono">
            {curlExample}
          </pre>
        </div>
      </Card>

      {/* JSON example */}
      <Card className="bg-gradient-card shadow-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-secondary" />
            {t("deploy.jsonExample.title")}
          </h3>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => handleCopy(JSON.stringify(jsonExample, null, 2), "json")}
          >
            {copied === "json" ? (
              <>
                <CheckCircle className="w-4 h-4 mr-1 text-accent" />
                {t("deploy.copied")}
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-1" />
                {t("deploy.copy")}
              </>
            )}
          </Button>
        </div>
        <div className="bg-foreground/5 rounded-xl p-4 overflow-x-auto">
          <pre className="text-sm text-muted-foreground font-mono">
            {JSON.stringify(jsonExample, null, 2)}
          </pre>
        </div>
      </Card>

      {/* Response example */}
      <Card className="bg-gradient-card shadow-card p-6">
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <CheckCircle className="w-5 h-5 text-accent" />
          {t("deploy.responseExample.title")}
        </h3>
        <div className="bg-foreground/5 rounded-xl p-4 overflow-x-auto">
          <pre className="text-sm text-muted-foreground font-mono">
            {JSON.stringify(responseExample, null, 2)}
          </pre>
        </div>
        <div className="mt-4 text-sm text-muted-foreground">
          {problemType === "classification" ? (
            <p>{t("deploy.responseExample.classificationDesc")}</p>
          ) : (
            <p>{t("deploy.responseExample.regressionDesc")}</p>
          )}
        </div>
      </Card>

      {/* Prediction Scheduler */}
      <PredictionScheduler 
        projectId={projectId} 
        productionModelName={productionModel.algorithm_name}
      />
    </div>
  );
};

export default APIDeployTab;
