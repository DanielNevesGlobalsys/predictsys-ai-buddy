import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cpu, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import ModelResultsTable from "@/components/training/ModelResultsTable";
import ModelSummaryCards from "@/components/models/ModelSummaryCards";
import ModelInsightsAI from "@/components/models/ModelInsightsAI";
import ModelRecalibration from "@/components/models/ModelRecalibration";
import { useNavigate } from "react-router-dom";
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

interface ModelsTabProps {
  projectId: string;
  problemType: string;
  datasetRows?: number;
  targetColumn?: string;
}

const ModelsTab = ({ projectId, problemType, datasetRows, targetColumn }: ModelsTabProps) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [productionThreshold, setProductionThreshold] = useState(0.5);

  const primaryMetric = problemType === "classification" ? "AUC" : "R²";
  const lowerIsBetter = problemType === "regression"; // For RMSE/MAE lower is better, but we use R² which higher is better

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
      console.error("Error loading models:", modelsError);
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
      // For AUC and R², higher is better
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
        <h3 className="font-semibold text-lg mb-2">{t("models.noModels")}</h3>
        <p className="text-muted-foreground mb-4">{t("models.noModelsDesc")}</p>
        <Button onClick={() => navigate(`/projeto/${projectId}/wizard`)}>
          {t("models.goToWizard")}
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <ModelSummaryCards
        bestModel={bestModel}
        productionModel={productionModel}
        primaryMetric={primaryMetric}
        problemType={problemType}
      />

      {/* Recalibration for production model (classification only) */}
      {problemType === "classification" && productionModel && (
        <div className="flex items-center justify-between p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
          <div>
            <p className="font-medium">{t("models.recalibration.productionCalibration")}</p>
            <p className="text-sm text-muted-foreground">
              {t("models.recalibration.currentThreshold")}: {productionThreshold}
            </p>
          </div>
          <ModelRecalibration
            modelName={productionModel.algorithm_name}
            metrics={productionModel.metrics}
            currentThreshold={productionThreshold}
            onSaveThreshold={setProductionThreshold}
          />
        </div>
      )}

      {/* Info box */}
      <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
        <p className="text-sm text-muted-foreground">
          <strong className="text-secondary">{t("models.selectProductionTitle")}:</strong>{" "}
          {t("models.selectProductionDesc")}
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

      {/* AI Insights */}
      <ModelInsightsAI
        projectId={projectId}
        models={models}
        problemType={problemType}
        bestModelId={bestModel?.id}
        productionModelId={productionModel?.id}
        datasetRows={datasetRows}
        targetColumn={targetColumn}
      />
    </div>
  );
};

export default ModelsTab;
