import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { 
  Cpu, Play, Clock, CheckCircle, Loader2, Trophy, AlertCircle, 
  HelpCircle, AlertTriangle, Sparkles, Info 
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ProjectData } from "../WizardContainer";
import ModelResultsTable from "@/components/training/ModelResultsTable";
import SmartTrainingPanel from "@/components/training/SmartTrainingPanel";
import UnifiedModelInsights from "@/components/training/UnifiedModelInsights";
import { trackEventWithTiming } from "@/lib/platformTracking";

interface StepTrainingProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  needsRetrain?: boolean;
  onTrainingComplete?: () => void;
}

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
  needsRetrain = false,
  onTrainingComplete,
}: StepTrainingProps) => {
  const { t } = useTranslation();
  const [isTraining, setIsTraining] = useState(false);
  const [models, setModels] = useState<ModelResult[]>([]);
  const [trainingComplete, setTrainingComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectedProblemType, setDetectedProblemType] = useState<string | null>(null);
  const [showTypeWarning, setShowTypeWarning] = useState(false);

  const primaryMetric = projectData.problem_type === "classification" ? "AUC" : "R²";

  useEffect(() => {
    loadExistingModels();
    detectProblemType();
  }, [projectData.id]);

  const detectProblemType = async () => {
    if (!projectData.id) return;

    // Check if target column has categorical stats (few distinct values = classification)
    const { data: catStats } = await supabase
      .from("project_categorical_stats")
      .select("distinct_count")
      .eq("project_id", projectData.id)
      .eq("column_name", projectData.target_column || "")
      .maybeSingle();

    const { data: numStats } = await supabase
      .from("project_numeric_stats")
      .select("min_value, max_value")
      .eq("project_id", projectData.id)
      .eq("column_name", projectData.target_column || "")
      .maybeSingle();

    let detected: string | null = null;

    if (catStats) {
      // If categorical stats exist, it's likely classification
      if (catStats.distinct_count && catStats.distinct_count <= 20) {
        detected = "classification";
      }
    } else if (numStats) {
      // If only numeric stats exist with many values, it's regression
      const range = (numStats.max_value || 0) - (numStats.min_value || 0);
      detected = range > 10 ? "regression" : "classification";
    }

    if (detected) {
      setDetectedProblemType(detected);
      
      // Update project with detected type
      await supabase
        .from("projects")
        .update({ detected_problem_type: detected })
        .eq("id", projectData.id);

      // Show warning if mismatch
      if (detected !== projectData.problem_type) {
        setShowTypeWarning(true);
      }
    }
  };

  const loadExistingModels = async () => {
    if (!projectData.id) return;

    const { data: modelsData, error: modelsError } = await supabase
      .from("project_models")
      .select("*")
      .eq("project_id", projectData.id);

    if (modelsError) {
      console.error("Error loading models:", modelsError);
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
      setTrainingComplete(modelsData.some(m => m.status === "trained"));
    }
  };

  const handleAcceptDetectedType = async () => {
    if (!detectedProblemType) return;
    
    await saveProject({ 
      problem_type: detectedProblemType as "classification" | "regression" 
    });
    setShowTypeWarning(false);
    toast.success(t("training.problemTypeUpdated"));
  };

  const handleStartTraining = async () => {
    if (!projectData.id || !projectData.target_column) {
      toast.error(t("stepTraining.errors.configureTarget"));
      return;
    }

    const startTime = Date.now();
    setIsTraining(true);
    setError(null);
    setModels([]);

    try {
      await saveProject({ status: "training" });

      const { data, error: fnError } = await supabase.functions.invoke("train-models", {
        body: { project_id: projectData.id },
      });

      if (fnError) {
        // Supabase functions return a generic "Edge function returned ..." error for non-2xx.
        // Try to extract the backend JSON body so we can show a useful message to the user.
        const ctxBody = (fnError as any)?.context?.body;
        if (ctxBody) {
          try {
            const parsed = typeof ctxBody === "string" ? JSON.parse(ctxBody) : ctxBody;
            const msg = parsed?.error || parsed?.message;
            if (msg) throw new Error(String(msg));
          } catch {
            // ignore parsing errors and fall back to the original error
          }
        }
        throw fnError;
      }

      if ((data as any)?.error) {
        throw new Error(String((data as any).error));
      }

      toast.success(t("stepTraining.trainingSuccess"));
      await loadExistingModels();
      setTrainingComplete(true);
      onTrainingComplete?.();

      // Track model training event
      trackEventWithTiming({
        event_type: "model_trained",
        project_id: projectData.id,
        status: "success",
        source: "app",
      }, startTime);

    } catch (err) {
      console.error("Training error:", err);
      const errorMessage = err instanceof Error ? err.message : t("stepTraining.errors.trainingFailed");
      
      // Parse different error types
      let userMessage = errorMessage;
      if (errorMessage.includes("violates check constraint")) {
        userMessage = t("stepTraining.errors.statusError");
      } else if (errorMessage.includes("non-2xx")) {
        userMessage = t("stepTraining.errors.serverError");
      } else if (errorMessage.includes("CPU") || errorMessage.includes("timeout") || errorMessage.includes("exceeded")) {
        userMessage = t("training.cpuLimitError");
      }
      
      setError(userMessage);
      toast.error(userMessage);
      await saveProject({ status: "eda_complete" });

      // Track job error event
      trackEventWithTiming({
        event_type: "job_error",
        project_id: projectData.id,
        status: "error",
        metadata: { stage: "training", error_message: userMessage },
        source: "app",
      }, startTime);
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
      return currentMetric > bestMetric ? current : best;
    });
  };

  const getRecommendedModelInfo = () => {
    const best = getBestModel();
    if (!best) return null;

    const metricValue = best.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0;
    
    // Generate reason and strength based on algorithm
    let reason = "";
    let strength = "";
    
    if (best.algorithm_name.includes("Random Forest")) {
      reason = t("training.reasons.randomForest");
      strength = t("training.strengths.randomForest");
    } else if (best.algorithm_name.includes("Gradient Boosting")) {
      reason = t("training.reasons.gradientBoosting");
      strength = t("training.strengths.gradientBoosting");
    } else if (best.algorithm_name.includes("Logística") || best.algorithm_name.includes("Logistic")) {
      reason = t("training.reasons.logisticRegression");
      strength = t("training.strengths.logisticRegression");
    } else if (best.algorithm_name.includes("Linear")) {
      reason = t("training.reasons.linearRegression");
      strength = t("training.strengths.linearRegression");
    } else if (best.algorithm_name.includes("k-NN") || best.algorithm_name.includes("KNN")) {
      reason = t("training.reasons.knn");
      strength = t("training.strengths.knn");
    } else if (best.algorithm_name.includes("Naive Bayes")) {
      reason = t("training.reasons.naiveBayes");
      strength = t("training.strengths.naiveBayes");
    } else if (best.algorithm_name.includes("Árvore") || best.algorithm_name.includes("Decision Tree")) {
      reason = t("training.reasons.decisionTree");
      strength = t("training.strengths.decisionTree");
    } else if (best.algorithm_name.includes("Ridge")) {
      reason = t("training.reasons.ridge");
      strength = t("training.strengths.ridge");
    } else {
      reason = t("training.reasons.default");
      strength = t("training.strengths.default");
    }

    return {
      name: best.algorithm_name,
      reason,
      strength,
      metric: primaryMetric,
      metricValue,
    };
  };

  const bestModel = getBestModel();
  const productionModel = models.find(m => m.is_production);
  const recommendedInfo = getRecommendedModelInfo();

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Cpu className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            {t("stepTraining.title")}
          </h2>
          <p className="text-muted-foreground">
            {t("stepTraining.subtitle")}
          </p>
        </div>

        {/* Problem Type Warning */}
        {showTypeWarning && detectedProblemType && (
          <Alert className="bg-warning/10 border-warning/30">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <AlertDescription className="flex items-center justify-between">
              <span>
                {t("training.typeWarning", { 
                  detected: t(`project.${detectedProblemType}`),
                  selected: t(`project.${projectData.problem_type}`)
                })}
              </span>
              <Button variant="outline" size="sm" onClick={handleAcceptDetectedType}>
                {t("training.useDetectedType")}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Problem Type Display */}
        <div className="flex items-center justify-center gap-2 p-3 bg-muted/50 rounded-lg">
          <Info className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {t("training.problemType")}: <strong>{t(`project.${projectData.problem_type}`)}</strong>
            {detectedProblemType && detectedProblemType === projectData.problem_type && (
              <span className="ml-2 text-accent">({t("training.autoDetected")})</span>
            )}
          </span>
        </div>

        {/* Smart Training Info */}
        <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
          <div className="flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-secondary mt-0.5" />
            <div>
              <p className="font-medium text-secondary">{t("training.smartTrainingTitle")}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t("training.smartTrainingDesc")}
              </p>
            </div>
          </div>
        </div>

        {/* Needs Retrain Warning */}
        {needsRetrain && (
          <Alert className="bg-warning/10 border-warning/30">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <AlertDescription>
              <p className="font-medium text-warning">
                {t("training.configChangedTitle")}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {t("training.configChangedDesc")}
              </p>
            </AlertDescription>
          </Alert>
        )}

        {/* Training status */}
        <div className="text-center py-8">
          {!isTraining && !trainingComplete && !error && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-muted rounded-2xl flex items-center justify-center mx-auto">
                <Clock className="w-10 h-10 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold text-lg">{t("stepTraining.readyToTrain")}</p>
                <p className="text-muted-foreground">
                  {t("training.readyToTrainSmartDesc")}
                </p>
              </div>
              <Button
                size="lg"
                onClick={handleStartTraining}
                disabled={!projectData.target_column}
                className="bg-gradient-primary hover:shadow-hover transition-all"
              >
                <Play className="w-5 h-5 mr-2" />
                {t("stepTraining.trainButton")}
              </Button>
            </div>
          )}

          {isTraining && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto">
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              </div>
              <div>
                <p className="font-semibold text-lg">{t("stepTraining.training")}</p>
                <p className="text-muted-foreground">
                  {t("training.trainingSmartDesc")}
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
                  {t("stepTraining.trainingError")}
                </p>
                <p className="text-muted-foreground">{error}</p>
              </div>
              {error === t("training.cpuLimitError") && (
                <div className="p-4 bg-muted/50 rounded-lg text-left max-w-md mx-auto">
                  <p className="text-sm font-medium mb-2">{t("training.cpuLimitSuggestions")}</p>
                  <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                    <li>{t("training.suggestion1")}</li>
                    <li>{t("training.suggestion2")}</li>
                    <li>{t("training.suggestion3")}</li>
                  </ul>
                </div>
              )}
              <Button
                size="lg"
                onClick={handleStartTraining}
                className="bg-gradient-primary hover:shadow-hover transition-all"
              >
                <Play className="w-5 h-5 mr-2" />
                {t("stepTraining.tryAgain")}
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
                  {t("stepTraining.trainingComplete")}
                </p>
                <p className="text-muted-foreground">
                  {t("stepTraining.trainingCompleteDesc", { count: models.filter(m => m.status === "trained").length })}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Results section */}
        {trainingComplete && models.length > 0 && (
          <div className="space-y-6">
            {/* Smart Training Panel - Recommended Model */}
            {recommendedInfo && (
              <SmartTrainingPanel
                recommendedModel={recommendedInfo}
                problemType={projectData.problem_type}
                detectedProblemType={detectedProblemType}
                userProblemType={projectData.problem_type}
              />
            )}

            {/* Model Comparison Table */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-primary" />
                <h3 className="font-semibold">{t("stepTraining.modelComparison")}</h3>
              </div>
              
              <p className="text-sm text-muted-foreground">
                {t("stepTraining.modelComparisonDesc", { metric: primaryMetric })}
              </p>

              <ModelResultsTable 
                models={models} 
                problemType={projectData.problem_type} 
                bestModelId={bestModel?.id}
              />
            </div>

            {/* Unified AI Insights Section */}
            <UnifiedModelInsights
              projectId={projectData.id || ""}
              modelId={productionModel?.id || bestModel?.id}
              modelName={productionModel?.algorithm_name || bestModel?.algorithm_name}
              problemType={projectData.problem_type}
              models={models}
              bestModelId={bestModel?.id}
              datasetRows={projectData.dataset_rows}
              targetColumn={projectData.target_column}
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading || isTraining}>
            {t("common.back")}
          </Button>
          <Button
            onClick={() => {
              if (needsRetrain) {
                toast.error(t("training.mustRetrainFirst"));
                return;
              }
              onNext();
            }}
            disabled={loading || isTraining || !trainingComplete || needsRetrain}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {t("common.next")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepTraining;
