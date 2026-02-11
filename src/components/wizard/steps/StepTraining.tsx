import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { 
  Cpu, Play, Clock, CheckCircle, Loader2, Trophy, AlertCircle, 
  HelpCircle, AlertTriangle, Sparkles, Info, XCircle, ArrowLeft
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ProjectData } from "../WizardContainer";
import ModelResultsTable from "@/components/training/ModelResultsTable";
import SmartTrainingPanel from "@/components/training/SmartTrainingPanel";
import UnifiedModelInsights from "@/components/training/UnifiedModelInsights";
import PipelineAuditPanel from "@/components/training/PipelineAuditPanel";
import TrainingPreflightPanel from "./TrainingPreflightPanel";
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

interface PreflightReport {
  target_valid: boolean;
  target_issues: string[];
  target_suggestions: string[];
  features_blocked: string[];
  features_block_reasons: Record<string, string>;
  warnings: string[];
}

interface TrainingErrorDetails {
  error: string;
  preflight_report?: PreflightReport;
  details?: string;
  action?: string;
  blocked_reason_code?: string;
}

interface TrainDiagnostics {
  primary_metric: string;
  primary_metric_value_raw: number;
  primary_metric_value_clamped: number;
  baseline_primary_metric: number;
  improvement_vs_baseline: number;
  raw_metrics_invalid_reasons: string[];
  sanity_checks_passed: boolean;
  sanity_fail_reasons: string[];
  model_quality_flag: string;
  dashboard_allowed: boolean;
  dashboard_allowed_reason: string;
  metrics_valid: boolean;
  can_promote_to_production: boolean;
}

interface TrainingQualityResult {
  model_quality_flag: string;
  can_promote_to_production: boolean;
  dashboard_allowed: boolean;
  dashboard_allowed_reason?: string;
  improvement_vs_baseline: number;
  metrics_valid: boolean;
  metrics_invalid_reasons: string[];
  training_warnings: string[];
  baseline_summary: Record<string, number>;
  metrics_summary: Record<string, number>;
  train_diagnostics?: TrainDiagnostics;
}

interface TrainReadiness {
  edaReady: boolean;
  modelReady: boolean;
  hasTarget: boolean;
  hasFeatures: boolean;
  hasContract: boolean;
  contractStatus: string | null;
  blockedReasonModel: string | null;
  totalRows: number;
  canTrain: boolean;
  blockReasons: string[];
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
  const [preflightReport, setPreflightReport] = useState<PreflightReport | null>(null);
  const [errorAction, setErrorAction] = useState<string | null>(null);
  const [detectedProblemType, setDetectedProblemType] = useState<string | null>(null);
  const [showTypeWarning, setShowTypeWarning] = useState(false);
  const [qualityResult, setQualityResult] = useState<TrainingQualityResult | null>(null);

  const [trainReadiness, setTrainReadiness] = useState<TrainReadiness | null>(null);

  const primaryMetric = projectData.problem_type === "classification" ? "AUC" : "R²";

  useEffect(() => {
    loadExistingModels();
    detectProblemType();
    checkTrainReadiness();
  }, [projectData.id]);

  const checkTrainReadiness = async () => {
    if (!projectData.id) return;

    const blockReasons: string[] = [];

    // Check SSOT dataset state first, then fallback to manifest
    const { data: dsState } = await supabase
      .from("project_dataset_state")
      .select("row_count, col_count, eda_ready, model_ready, virtual_manifest, diagnostics")
      .eq("project_id", projectData.id)
      .maybeSingle();

    let edaReady = true;
    let modelReady = true;
    let totalRows = 0;
    let blockedReasonModel: string | null = null;

    if (dsState && (dsState as any).row_count > 0) {
      edaReady = (dsState as any).eda_ready !== false;
      modelReady = (dsState as any).model_ready !== false;
      totalRows = (dsState as any).row_count;
      blockedReasonModel = (dsState as any).diagnostics?.blocked_reason_model || null;
    } else {
      // Fallback to manifest
      const { data: manifest } = await supabase
        .from("import_manifests")
        .select("eda_ready, model_ready, blocked_reason_model, rows_consolidated")
        .eq("project_id", projectData.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      edaReady = manifest?.eda_ready !== false;
      modelReady = manifest?.model_ready !== false;
      totalRows = manifest?.rows_consolidated || projectData.total_rows || 0;
      blockedReasonModel = manifest?.blocked_reason_model as string | null;
    }

    if (!edaReady) blockReasons.push("Dataset não está pronto para análise (EDA bloqueado).");

    // Check modeling contract
    const { data: contract } = await supabase
      .from("project_modeling_contracts")
      .select("status, features_final, blocked_reasons")
      .eq("project_id", projectData.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const hasContract = !!contract;
    const contractStatus = contract?.status || null;
    if (contract?.status === "blocked") {
      const reasons = contract.blocked_reasons as any;
      blockReasons.push(`Contrato de modelagem bloqueado: ${Array.isArray(reasons) ? reasons.join("; ") : String(reasons || "")}`);
    }

    const featuresFinal = contract?.features_final as any[] | null;
    const hasFeatures = !featuresFinal || (Array.isArray(featuresFinal) && featuresFinal.length >= 2);
    if (featuresFinal && Array.isArray(featuresFinal) && featuresFinal.length < 2) {
      blockReasons.push(`Apenas ${featuresFinal.length} feature(s) selecionada(s). Mínimo: 2.`);
    }

    const hasTarget = !!projectData.target_column;
    if (!hasTarget) blockReasons.push("Variável alvo (target) não definida.");

    if (totalRows === 0) blockReasons.push("Dataset sem linhas válidas.");

    const canTrain = edaReady && hasTarget && blockReasons.length === 0;

    setTrainReadiness({
      edaReady,
      modelReady,
      hasTarget,
      hasFeatures,
      hasContract,
      contractStatus,
      blockedReasonModel,
      totalRows,
      canTrain,
      blockReasons,
    });
  };

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
    setPreflightReport(null);
    setErrorAction(null);
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
            const parsed: TrainingErrorDetails = typeof ctxBody === "string" ? JSON.parse(ctxBody) : ctxBody;
            if (parsed?.preflight_report) {
              setPreflightReport(parsed.preflight_report);
              setErrorAction(parsed.action || null);
            }
            const msg = parsed?.error || parsed?.details;
            if (msg) throw new Error(String(msg));
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== ctxBody) throw parseErr;
            // ignore JSON parsing errors and fall back to the original error
          }
        }
        throw fnError;
      }

      if ((data as any)?.error) {
        if ((data as any)?.preflight_report) {
          setPreflightReport((data as any).preflight_report);
          setErrorAction((data as any).action || null);
        }
        throw new Error(String((data as any).error));
      }

      // Capture quality result from backend
      if (data) {
        const d = data as any;
        setQualityResult({
          model_quality_flag: d.model_quality_flag || "ok",
          can_promote_to_production: d.can_promote_to_production ?? true,
          dashboard_allowed: d.dashboard_allowed ?? true,
          improvement_vs_baseline: d.improvement_vs_baseline ?? 0,
          metrics_valid: d.metrics_valid ?? true,
          metrics_invalid_reasons: d.metrics_invalid_reasons || [],
          training_warnings: d.training_warnings || [],
          baseline_summary: d.baseline_summary || {},
          metrics_summary: d.metrics_summary || {},
        });
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

        {/* Training Preflight Panel — always visible */}
        <TrainingPreflightPanel projectId={projectData.id} onNavigateBack={onBack} />

        {/* Pre-train Readiness Panel */}
        {trainReadiness && !trainingComplete && !isTraining && (
          <div className={`p-4 rounded-lg border space-y-3 ${
            trainReadiness.canTrain
              ? "bg-primary/5 border-primary/20"
              : "bg-destructive/5 border-destructive/20"
          }`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm font-semibold">Pré-checagem de treino</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge className={trainReadiness.edaReady ? "bg-accent/20 text-accent border-accent/30 text-[10px]" : "bg-destructive/20 text-destructive border-destructive/30 text-[10px]"}>
                  {trainReadiness.edaReady ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  EDA
                </Badge>
                <Badge className={trainReadiness.hasTarget ? "bg-accent/20 text-accent border-accent/30 text-[10px]" : "bg-destructive/20 text-destructive border-destructive/30 text-[10px]"}>
                  {trainReadiness.hasTarget ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  TARGET
                </Badge>
                <Badge className={trainReadiness.modelReady ? "bg-accent/20 text-accent border-accent/30 text-[10px]" : "bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]"}>
                  {trainReadiness.modelReady ? <CheckCircle className="w-3 h-3 mr-1" /> : <AlertTriangle className="w-3 h-3 mr-1" />}
                  MODEL
                </Badge>
              </div>
            </div>

            {trainReadiness.totalRows > 0 && (
              <p className="text-xs text-muted-foreground">
                {trainReadiness.totalRows.toLocaleString()} linhas disponíveis para treino
              </p>
            )}

            {!trainReadiness.modelReady && trainReadiness.blockedReasonModel && trainReadiness.canTrain && (
              <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/5 p-2 rounded border border-amber-500/20">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>⚠️ {trainReadiness.blockedReasonModel}. O treino pode prosseguir, mas resultados podem ser limitados.</span>
              </div>
            )}

            {trainReadiness.blockReasons.length > 0 && (
              <div className="space-y-1.5">
                {trainReadiness.blockReasons.map((reason, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
                    <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{reason}</span>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={onBack} className="mt-2">
                  <ArrowLeft className="w-4 h-4 mr-1.5" />
                  Voltar e revisar Target/Features
                </Button>
              </div>
            )}
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
                <p className="font-semibold text-lg">{t("stepTraining.readyToTrain")}</p>
                <p className="text-muted-foreground">
                  {t("training.readyToTrainSmartDesc")}
                </p>
              </div>
              <Button
                size="lg"
                onClick={handleStartTraining}
                disabled={!projectData.target_column || (trainReadiness ? !trainReadiness.canTrain : false)}
                className="bg-gradient-primary hover:shadow-hover transition-all"
              >
                <Play className="w-5 h-5 mr-2" />
                {trainReadiness && !trainReadiness.canTrain
                  ? "Treino bloqueado — revise configurações"
                  : t("stepTraining.trainButton")}
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

              {/* Preflight Report — actionable target/feature issues */}
              {preflightReport && (
                <div className="p-4 bg-destructive/5 border border-destructive/20 rounded-lg text-left max-w-lg mx-auto space-y-3">
                  {preflightReport.target_issues.length > 0 && (
                    <div>
                      <p className="text-sm font-semibold flex items-center gap-1.5 text-destructive mb-1">
                        <AlertTriangle className="w-4 h-4" />
                        {t("training.preflight.targetIssues", "Problemas no Target")}
                      </p>
                      <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                        {preflightReport.target_issues.map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {preflightReport.target_suggestions.length > 0 && (
                    <div>
                      <p className="text-sm font-semibold flex items-center gap-1.5 text-primary mb-1">
                        <Sparkles className="w-4 h-4" />
                        {t("training.preflight.suggestions", "Sugestões")}
                      </p>
                      <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                        {preflightReport.target_suggestions.map((sug, i) => (
                          <li key={i}>{sug}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {preflightReport.features_blocked.length > 0 && (
                    <div>
                      <p className="text-sm font-semibold mb-1">
                        {t("training.preflight.featuresBlocked", "Features Bloqueadas")}
                      </p>
                      <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                        {preflightReport.features_blocked.map((feat, i) => (
                          <li key={i}>
                            <strong>{feat}</strong>: {preflightReport.features_block_reasons[feat]}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {errorAction === "review_target" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onBack}
                      className="mt-2"
                    >
                      <AlertTriangle className="w-4 h-4 mr-1.5" />
                      {t("training.preflight.reviewTarget", "Voltar e revisar o Target")}
                    </Button>
                  )}
                </div>
              )}

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

        {/* Quality Gate Panel — shows after training */}
        {trainingComplete && qualityResult && (
          <div className={`p-4 rounded-lg border space-y-3 ${
            qualityResult.model_quality_flag === "ok"
              ? "bg-accent/5 border-accent/20"
              : qualityResult.model_quality_flag === "weak_model"
              ? "bg-amber-500/5 border-amber-500/20"
              : "bg-destructive/5 border-destructive/20"
          }`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm font-semibold">Avaliação de Qualidade do Modelo</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge className={qualityResult.metrics_valid
                  ? "bg-accent/20 text-accent border-accent/30 text-[10px]"
                  : "bg-destructive/20 text-destructive border-destructive/30 text-[10px]"}>
                  {qualityResult.metrics_valid ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  MÉTRICAS
                </Badge>
                <Badge className={qualityResult.can_promote_to_production
                  ? "bg-accent/20 text-accent border-accent/30 text-[10px]"
                  : "bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]"}>
                  {qualityResult.can_promote_to_production ? <CheckCircle className="w-3 h-3 mr-1" /> : <AlertTriangle className="w-3 h-3 mr-1" />}
                  PRODUÇÃO
                </Badge>
                <Badge className={qualityResult.dashboard_allowed
                  ? "bg-accent/20 text-accent border-accent/30 text-[10px]"
                  : "bg-destructive/20 text-destructive border-destructive/30 text-[10px]"}>
                  {qualityResult.dashboard_allowed ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  DASHBOARD
                </Badge>
              </div>
            </div>

            {/* Baseline comparison */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-2 bg-muted/50 rounded">
                <p className="font-medium text-muted-foreground mb-1">Baseline</p>
                {Object.entries(qualityResult.baseline_summary).slice(0, 3).map(([k, v]) => (
                  <p key={k}>{k}: {typeof v === "number" ? v.toFixed(4) : v}</p>
                ))}
              </div>
              <div className="p-2 bg-muted/50 rounded">
                <p className="font-medium text-muted-foreground mb-1">Modelo</p>
                {Object.entries(qualityResult.metrics_summary).slice(0, 3).map(([k, v]) => (
                  <p key={k}>{k}: {typeof v === "number" ? v.toFixed(4) : v}</p>
                ))}
              </div>
            </div>

            {qualityResult.train_diagnostics && (
              <div className="p-2 bg-muted/30 rounded text-[11px] space-y-0.5">
                <p className="font-medium text-muted-foreground mb-1">Diagnóstico do Treino</p>
                <p>Métrica primária: <span className="font-semibold">{qualityResult.train_diagnostics.primary_metric}</span> = {qualityResult.train_diagnostics.primary_metric_value_raw.toFixed(4)} (raw) / {qualityResult.train_diagnostics.primary_metric_value_clamped.toFixed(4)} (clamped)</p>
                <p>Baseline: {qualityResult.train_diagnostics.baseline_primary_metric.toFixed(4)}</p>
                <p className={qualityResult.train_diagnostics.improvement_vs_baseline > 0 ? "text-accent font-medium" : "text-destructive font-medium"}>
                  Melhoria: {qualityResult.train_diagnostics.improvement_vs_baseline > 0 ? "+" : ""}{qualityResult.train_diagnostics.improvement_vs_baseline.toFixed(4)}
                </p>
                <p>Sanity: {qualityResult.train_diagnostics.sanity_checks_passed ? "✅ OK" : `❌ ${qualityResult.train_diagnostics.sanity_fail_reasons.join("; ")}`}</p>
                <p>Dashboard: {qualityResult.train_diagnostics.dashboard_allowed ? "✅ Liberado" : `❌ ${qualityResult.train_diagnostics.dashboard_allowed_reason}`}</p>
                {qualityResult.train_diagnostics.raw_metrics_invalid_reasons.length > 0 && (
                  <p className="text-destructive">Métricas inválidas: {qualityResult.train_diagnostics.raw_metrics_invalid_reasons.join("; ")}</p>
                )}
              </div>
            )}

            {/* Zombie model warning */}
            {!qualityResult.dashboard_allowed && (
              <Alert className="bg-destructive/10 border-destructive/30">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                <AlertDescription className="text-xs">
                  ⚠️ Modelo treinado, porém não atingiu qualidade mínima para produção. 
                  O dashboard executivo está bloqueado. 
                  {qualityResult.dashboard_allowed_reason && (
                    <span className="font-medium"> Motivo: {qualityResult.dashboard_allowed_reason}.</span>
                  )}
                  {" "}Revise o target e as features e retreine o modelo.
                </AlertDescription>
              </Alert>
            )}

            {qualityResult.training_warnings.length > 0 && qualityResult.dashboard_allowed && (
              <div className="space-y-1">
                {qualityResult.training_warnings.slice(0, 5).map((w, i) => (
                  <p key={i} className="text-[11px] text-amber-600 flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

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

            {/* Pipeline Audit Panel (admin only) */}
            <PipelineAuditPanel projectId={projectData.id || ""} />
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
