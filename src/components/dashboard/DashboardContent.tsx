import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import DashboardKPICards from "./DashboardKPICards";
import DashboardPerformanceCharts from "./DashboardPerformanceCharts";
import DashboardFeatureImportance from "./DashboardFeatureImportance";
import DashboardSegmentation from "./DashboardSegmentation";
import DashboardAIInsights from "./DashboardAIInsights";
import DashboardFilters from "./DashboardFilters";
import DashboardExportPDF from "./DashboardExportPDF";

interface DashboardContentProps {
  projectId: string;
  problemType: string;
  targetColumn?: string;
  projectName: string;
}

interface ModelData {
  id: string;
  algorithm_name: string;
  is_production: boolean;
  trained_at: string | null;
  metrics: { metric_name: string; metric_value: number }[];
}

interface DashboardData {
  models: ModelData[];
  productionModel: ModelData | null;
  featureImportances: { feature_name: string; importance_value: number }[];
  totalPredictions: number;
  lastPredictionAt: string | null;
}

const DashboardContent = ({ projectId, problemType, targetColumn, projectName }: DashboardContentProps) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<string>("validation");
  const [availableSplits, setAvailableSplits] = useState<string[]>(["training", "validation"]);

  useEffect(() => {
    loadDashboardData();
  }, [projectId, selectedDataset]);

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      // Load models with metrics
      const { data: modelsData } = await supabase
        .from("project_models")
        .select("*")
        .eq("project_id", projectId)
        .eq("status", "trained")
        .order("trained_at", { ascending: false });

      const models: ModelData[] = [];
      let productionModel: ModelData | null = null;
      let featureImportances: { feature_name: string; importance_value: number }[] = [];

      if (modelsData && modelsData.length > 0) {
        for (const model of modelsData) {
          const { data: metrics } = await supabase
            .from("project_model_metrics")
            .select("metric_name, metric_value")
            .eq("project_model_id", model.id);

          const modelWithMetrics: ModelData = {
            id: model.id,
            algorithm_name: model.algorithm_name,
            is_production: model.is_production,
            trained_at: model.trained_at,
            metrics: metrics || [],
          };

          models.push(modelWithMetrics);

          if (model.is_production) {
            productionModel = modelWithMetrics;

            // Load feature importances for production model
            const { data: importances } = await supabase
              .from("project_feature_importances")
              .select("feature_name, importance_value")
              .eq("project_model_id", model.id)
              .order("importance_value", { ascending: false })
              .limit(10);

            if (importances) {
              featureImportances = importances;
            }
          }
        }
      }

      // Check if test set exists (we'll check based on dataset_rows vs sample_rows ratio)
      // For now, we assume validation is always available, test may or may not be
      // In a real implementation, this would come from the training output
      const { data: project } = await supabase
        .from("projects")
        .select("sample_rows, total_rows")
        .eq("id", projectId)
        .single();
      
      // If sample size is significantly less than total, assume we have a test set
      const hasTestSet = project?.sample_rows && project?.total_rows && 
        project.sample_rows < project.total_rows * 0.9;
      
      setAvailableSplits(hasTestSet ? ["training", "validation", "test"] : ["training", "validation"]);

      setDashboardData({
        models,
        productionModel,
        featureImportances,
        totalPredictions: 0,
        lastPredictionAt: null,
      });
    } catch (error) {
      console.error("Error loading dashboard data:", error);
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!dashboardData || !dashboardData.productionModel) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">{t("modelDashboard.noProductionModel")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters and Export */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <DashboardFilters
          selectedDataset={selectedDataset}
          onDatasetChange={setSelectedDataset}
          availableSplits={availableSplits}
        />
        <DashboardExportPDF
          projectId={projectId}
          projectName={projectName}
          problemType={problemType}
          dashboardData={dashboardData}
        />
      </div>

      {/* KPI Cards */}
      <DashboardKPICards
        problemType={problemType}
        productionModel={dashboardData.productionModel}
        totalPredictions={dashboardData.totalPredictions}
        lastPredictionAt={dashboardData.lastPredictionAt}
      />

      {/* Performance Charts */}
      <DashboardPerformanceCharts
        problemType={problemType}
        models={dashboardData.models}
        productionModel={dashboardData.productionModel}
      />

      {/* Feature Importance */}
      <DashboardFeatureImportance
        featureImportances={dashboardData.featureImportances}
      />

      {/* Segmentation */}
      <DashboardSegmentation
        problemType={problemType}
        productionModelId={dashboardData.productionModel.id}
      />

      {/* AI Insights */}
      <DashboardAIInsights
        projectId={projectId}
        modelId={dashboardData.productionModel.id}
        problemType={problemType}
      />
    </div>
  );
};

export default DashboardContent;
