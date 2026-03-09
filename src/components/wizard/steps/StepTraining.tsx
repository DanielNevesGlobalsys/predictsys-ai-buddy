import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { 
  Cpu, Play, Clock, CheckCircle, Loader2, Trophy, AlertCircle, 
  HelpCircle, AlertTriangle, Sparkles, Info, XCircle, ArrowLeft, Settings2, Activity
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ProjectData } from "../WizardContainer";
import ModelResultsTable from "@/components/training/ModelResultsTable";
import TrainingResultsPanel from "./TrainingResultsPanel";
import DebugLysPanel from "@/components/training/DebugLysPanel";
import UnifiedModelInsights from "@/components/training/UnifiedModelInsights";
import PipelineAuditPanel from "@/components/training/PipelineAuditPanel";
import TrainingPreflightPanel from "./TrainingPreflightPanel";
import TrainabilityDiagnosticCard from "./TrainabilityDiagnosticCard";
import PipelineDiagnosticsModal from "../shared/PipelineDiagnosticsModal";
import TrainingMetricsReport from "@/components/training/TrainingMetricsReport";
import ChurnSimulator from "@/components/business-impact/ChurnSimulator";
import { trackEventWithTiming } from "@/lib/platformTracking";
import { useDatasetState } from "@/hooks/useDatasetState";
import type { BusinessIntentContract } from "@/lib/industryRules";
import { INDUSTRY_OBJECTIVE_MATRIX, buildBusinessIntentContract } from "@/lib/industryRules";
import type { IndustryKey, ObjectiveKey } from "@/lib/industryRules";

interface StepTrainingProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  needsRetrain?: boolean;
  onTrainingComplete?: () => void;
  onGoToStep?: (step: number) => void;
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

interface FeatureDiagnosticExample {
  col: string;
  n_unique: number;
  pct_null: number;
  reason: string;
}

interface TrainingErrorDetails {
  error: string;
  preflight_report?: PreflightReport;
  details?: string | Record<string, unknown>;
  action?: string;
  blocked_reason_code?: string;
  error_code?: string;
  reason_code?: string;
  code?: string;
  status?: string;
  message_user?: string;
  fix_suggestions?: { label: string; action: string; hint?: Record<string, unknown> }[];
  success?: boolean;
  warnings?: string[];
  features_selected_count?: number;
  features_blocked_count?: number;
  top_block_reasons?: Record<string, number>;
  examples?: FeatureDiagnosticExample[];
  feature_diagnostic?: Record<string, { n_unique: number; pct_null: number; reason: string }>;
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
  onGoToStep,
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
  const [trainabilityError, setTrainabilityError] = useState<TrainingErrorDetails | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [extendedMetrics, setExtendedMetrics] = useState<any>(null);
  const [leakageReport, setLeakageReport] = useState<any>(null);

  const [trainReadiness, setTrainReadiness] = useState<TrainReadiness | null>(null);
  const [edaDebug, setEdaDebug] = useState<{ data: any; error: any } | null>(null);

  // SSOT dataset state — force reload on mount
  const ds = useDatasetState(projectData.id);

  // Selection version for display + preflight refresh
  const [selectionVersion, setSelectionVersion] = useState<number | null>(null);
  const [preflightRefreshKey, setPreflightRefreshKey] = useState(0);

  // Business intent contract summary
  const [contractSummary, setContractSummary] = useState<{
    industry: string;
    objective: string;
    problemType: string;
    doBullets: string[];
    advancedMode: boolean;
    industryLabel: string;
    objectiveLabel: string;
  } | null>(null);

  const primaryMetric = projectData.problem_type === "classification" ? "AUC" : "R²";

  const loadSelectionVersion = useCallback(async () => {
    if (!projectData.id) return;
    const { data } = await supabase
      .from("project_model_selection" as any)
      .select("selection_version")
      .eq("project_id", projectData.id)
      .maybeSingle();
    if (data) setSelectionVersion((data as any).selection_version);
  }, [projectData.id]);

  const loadContractSummary = useCallback(async () => {
    if (!projectData.id) return;
    const { data } = await supabase
      .from("project_settings")
      .select("business_intent_contract, objective, industry, advanced_mode_enabled")
      .eq("project_id", projectData.id)
      .maybeSingle();
    if (!data) return;
    const ps = data as any;
    let contract: BusinessIntentContract | null = ps.business_intent_contract;
    if (!contract && ps.industry && ps.objective) {
      try { contract = buildBusinessIntentContract(ps.industry, ps.objective); } catch { /* noop */ }
    }
    if (!contract) return;
    const industryLabels: Record<string, string> = { retail: "Varejo", health: "Saúde", finance: "Finanças", education: "Educação", logistics: "Logística", generic: "Geral" };
    const objDef = INDUSTRY_OBJECTIVE_MATRIX[contract.industry]?.objectives.find(o => o.key === contract!.objective);
    setContractSummary({
      industry: contract.industry,
      objective: contract.objective,
      problemType: contract.problem_type_default,
      doBullets: contract.target_recommendations.do.slice(0, 2),
      advancedMode: ps.advanced_mode_enabled === true,
      industryLabel: industryLabels[contract.industry] || contract.industry,
      objectiveLabel: objDef?.label_pt || contract.objective,
    });
  }, [projectData.id]);

  // Track whether we already checked for builder outdated redirect
  const [builderOutdatedChecked, setBuilderOutdatedChecked] = useState(false);
  const [builderOutdated, setBuilderOutdated] = useState(false);

  useEffect(() => {
    loadExistingModels();
    detectProblemType();
    checkTrainReadiness();
    ds.load();
    loadSelectionVersion();
    runPreflightGuard();
    setPreflightRefreshKey(k => k + 1);
    loadContractSummary();
  }, [projectData.id]);

  const runPreflightGuard = useCallback(async () => {
    if (!projectData.id) return;
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("run-training-preflight", {
        body: { project_id: projectData.id },
      });
      if (fnErr || !data) return;
      const result = data as any;
      if (!result.builder_is_current || result.blocked_reason_code === "BUILDER_OUTDATED") {
        setBuilderOutdated(true);
        const currentV = result.selection_version_current || "?";
        const builtV = result.selection_version_used_by_builder ?? "?";
        // Auto-trigger builder rebuild instead of redirecting back
        toast.info(
          `Atualizando dataset modelável (v${builtV} → v${currentV})...`,
          { duration: 5000 }
        );
        try {
          const rebuildRes = await supabase.functions.invoke("build-modeling-dataset", {
            body: { project_id: projectData.id },
          });
          if (rebuildRes.data?.modeling_dataset_ready) {
            toast.success("Dataset modelável atualizado com sucesso!");
            setBuilderOutdated(false);
            setPreflightRefreshKey(k => k + 1);
          } else {
            const reasons = rebuildRes.data?.blocked_reasons || [];
            toast.warning(
              reasons.length > 0
                ? `Builder bloqueado: ${reasons[0]}`
                : "Dataset modelável gerado mas com pendências. Verifique o Preflight.",
              { duration: 8000 }
            );
            setPreflightRefreshKey(k => k + 1);
          }
        } catch (rebuildErr) {
          console.error("[StepTraining] auto-rebuild failed:", rebuildErr);
          toast.error("Erro ao reconstruir dataset. Use o botão no Preflight.");
        }
      }
      setBuilderOutdatedChecked(true);
    } catch (err) {
      console.error("[StepTraining] preflight guard error:", err);
      setBuilderOutdatedChecked(true);
    }
  }, [projectData.id]);

  const checkTrainReadiness = async () => {
    if (!projectData.id) return;

    const blockReasons: string[] = [];

    // Use compute_eda_ready RPC as single source of truth
    let edaReady = true;
    let modelReady = true;
    let totalRows = 0;
    let blockedReasonModel: string | null = null;

    try {
      const { data: edaResult, error: edaErr } = await supabase.rpc("compute_eda_ready" as any, { p_project_id: projectData.id });
      
      console.log("[checkTrainReadiness] compute_eda_ready result:", { data: edaResult, error: edaErr });
      setEdaDebug({ data: edaResult, error: edaErr });

      if (!edaErr && edaResult) {
        const r = edaResult as any;
        edaReady = r.eda_ready === true;
        totalRows = r.evidence?.rows_len || 0;

        if (!edaReady) {
          const reasons: string[] = r.reasons || [];
          // Map reason codes to user-friendly messages
          const reasonMap: Record<string, string> = {
            no_active_dataset: "Nenhum dataset ativo registrado.",
            zero_rows: "Dataset com 0 linhas.",
            insufficient_columns: "Dataset com menos de 2 colunas.",
            no_sample: "Amostra do dataset não encontrada.",
            no_eda_evidence: "EDA não foi calculado. Execute na Etapa 2.",
          };
          reasons.forEach(code => {
            blockReasons.push(reasonMap[code] || code);
          });
        }

        modelReady = true; // determined by preflight gates
      } else {
        console.warn("[checkTrainReadiness] compute_eda_ready failed, using permissive defaults", edaErr);
        edaReady = true;
        totalRows = projectData.total_rows || 0;
      }
    } catch (err) {
      console.warn("[checkTrainReadiness] Error calling compute_eda_ready:", err);
      edaReady = true;
      totalRows = projectData.total_rows || 0;
    }

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

    if (totalRows === 0 && blockReasons.length === 0) blockReasons.push("Dataset sem linhas válidas.");

    const canTrain = hasTarget && blockReasons.length === 0;

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
    setTrainabilityError(null);
    setModels([]);

    try {
      await saveProject({ status: "training" });

      const uiRequestId = crypto.randomUUID();

      const { data, error: fnError } = await supabase.functions.invoke("train-models", {
        body: { project_id: projectData.id, ui_request_id: uiRequestId },
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

      if ((data as any)?.success === false || (data as any)?.error) {
        const d = data as any;
        // Handle TARGET_NOT_TRAINABLE specifically
        if (d.error_code === "TARGET_NOT_TRAINABLE") {
          setTrainabilityError(d);
          setError(d.error || "Target não treinável");
          throw new Error(d.error || "Target não treinável");
        }
        // Handle NO_VALID_FEATURES or blocked status (TARGET_TYPE_MISMATCH, LOW_VARIANCE_TARGET, etc.)
        if (d.code === "NO_VALID_FEATURES" || d.code === "TARGET_TYPE_MISMATCH" || d.code === "LOW_VARIANCE_TARGET" || d.code === "ONLY_ONE_CLASS" || d.status === "blocked") {
          setTrainabilityError(d);
          setError(d.message_user || d.error || "Treino bloqueado");
          throw new Error(d.message_user || d.error || "Treino bloqueado");
        }
        // Handle TRAINING_CRASH with structured error
        if (d.code === "TRAINING_CRASH" || d.status === "error") {
          const requestId = d.error?.request_id || "N/A";
          const errorCode = d.code || "UNKNOWN";
          const step = d.error?.step || "init";
          const crashError = new Error(d.message_user || "Erro interno no treinamento");
          (crashError as any).__trainingCrash = { request_id: requestId, code: errorCode, step, ui_request_id: uiRequestId };
          throw crashError;
        }
        if (d.preflight_report) {
          setPreflightReport(d.preflight_report);
          setErrorAction(d.action || null);
        }
        throw new Error(String(d.error));
      }

      // Capture quality result from backend
      if (data) {
        const d = data as any;
        setQualityResult({
          model_quality_flag: d.model_quality_flag || "ok",
          can_promote_to_production: d.can_promote_to_production ?? true,
          dashboard_allowed: d.dashboard_allowed ?? true,
          dashboard_allowed_reason: d.dashboard_allowed_reason || undefined,
          improvement_vs_baseline: d.improvement_vs_baseline ?? 0,
          metrics_valid: d.metrics_valid ?? true,
          metrics_invalid_reasons: d.metrics_invalid_reasons || [],
          training_warnings: d.training_warnings || d.warnings || [],
          baseline_summary: d.baseline_summary || {},
          metrics_summary: d.metrics_summary?.model || d.metrics_summary || {},
          train_diagnostics: d.train_diagnostics || undefined,
        });
        // Capture extended metrics and leakage report
        if (d.extended_metrics) setExtendedMetrics(d.extended_metrics);
        if (d.leakage_report) setLeakageReport(d.leakage_report);
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
      
      // Check for structured TRAINING_CRASH
      const crashInfo = (err as any)?.__trainingCrash;
      
      // Parse different error types
      let userMessage = errorMessage;
      if (crashInfo) {
        const stepLabel = crashInfo.step && crashInfo.step !== "init" ? crashInfo.step : "inicialização";
        userMessage = `Falha no treino na etapa: ${stepLabel}`;
      } else if (errorMessage.includes("violates check constraint")) {
        userMessage = t("stepTraining.errors.statusError");
      } else if (errorMessage.includes("non-2xx")) {
        userMessage = t("stepTraining.errors.serverError");
      } else if (errorMessage.includes("CPU") || errorMessage.includes("timeout") || errorMessage.includes("exceeded")) {
        userMessage = t("training.cpuLimitError");
      }
      
      setError(userMessage);
      
      if (crashInfo) {
        const clipboardText = [
          `TRAINING_CRASH | step: ${crashInfo.step || "init"}`,
          `request_id: ${crashInfo.request_id}`,
          crashInfo.ui_request_id ? `ui_request_id: ${crashInfo.ui_request_id}` : "",
        ].filter(Boolean).join(" | ");

        toast.error(userMessage, {
          description: `Request ID: ${crashInfo.request_id}${crashInfo.ui_request_id ? `\nUI ID: ${crashInfo.ui_request_id}` : ""}`,
          action: {
            label: "Copiar código",
            onClick: () => {
              navigator.clipboard.writeText(clipboardText);
              toast.success("Código copiado!");
            },
          },
          duration: 15000,
        });
      } else {
        toast.error(userMessage);
      }
      
      await saveProject({ status: "eda_complete" });

      // Track job error event
      trackEventWithTiming({
        event_type: "job_error",
        project_id: projectData.id,
        status: "error",
        metadata: { 
          stage: "training", 
          error_message: userMessage,
          ...(crashInfo ? { request_id: crashInfo.request_id, code: crashInfo.code, step: crashInfo.step } : {}),
        },
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
          <div className="flex items-center justify-end mb-2">
            <PipelineDiagnosticsModal projectId={projectData.id} />
          </div>
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

        {/* ═══ Business Intent Contract Summary ═══ */}
        {contractSummary && (
          <div className="p-4 border border-primary/20 bg-primary/5 rounded-lg space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[10px]">{contractSummary.industryLabel}</Badge>
              <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px]">{contractSummary.objectiveLabel}</Badge>
              <Badge variant="outline" className="text-[10px]">
                {contractSummary.problemType === "classification" ? "Classificação" : contractSummary.problemType === "regression" ? "Regressão" : "Clustering"}
              </Badge>
              {contractSummary.advancedMode && (
                <Badge className="bg-accent/20 text-accent border-accent/30 text-[9px] gap-1">
                  <Settings2 className="w-3 h-3" />
                  Avançado ligado
                </Badge>
              )}
            </div>
            {contractSummary.doBullets.length > 0 && (
              <ul className="text-xs text-muted-foreground space-y-0.5 pl-4 list-disc">
                {contractSummary.doBullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        )}

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

        {/* Training Preflight Panel — always visible, force-refreshed on mount */}
        <TrainingPreflightPanel projectId={projectData.id} onNavigateBack={onBack} refreshKey={preflightRefreshKey} />

        {/* Selection version display */}
        {selectionVersion !== null && (
          <div className="flex items-center gap-2 p-2 bg-muted/30 rounded-lg text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5" />
            <span>Seleção atual: <strong>v{selectionVersion}</strong></span>
          </div>
        )}

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

            {/* EDA Debug Panel — collapsible raw RPC output */}
            {edaDebug && (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-[10px] text-muted-foreground mt-1">
                    <Info className="w-3 h-3 mr-1" /> Debug: compute_eda_ready
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="text-[10px] bg-muted/50 border border-border rounded p-2 mt-1 overflow-auto max-h-48 whitespace-pre-wrap">
                    {edaDebug.error
                      ? `RPC ERROR:\n${JSON.stringify(edaDebug.error, null, 2)}`
                      : JSON.stringify(edaDebug.data, null, 2)}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
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
              {/* Trainability Diagnostic Card */}
              {trainabilityError && trainabilityError.error_code === "TARGET_NOT_TRAINABLE" && (
                <TrainabilityDiagnosticCard
                  reasonCode={trainabilityError.reason_code || "UNKNOWN"}
                  details={trainabilityError.details as any || { n_rows: 0, n_non_null: 0, n_unique: 0, positive_rate: 0, top_class_pct: 0, minor_class_count: 0, conflict_rate: 0, coverage: 0 }}
                  fixSuggestions={trainabilityError.fix_suggestions || []}
                  warnings={trainabilityError.warnings as string[] || []}
                  humanMessage={trainabilityError.error || error}
                  onGoToStep={(step) => {
                    if (onGoToStep) onGoToStep(step);
                    else onBack();
                  }}
                  onBack={onBack}
                />
              )}

              {/* NO_VALID_FEATURES Diagnostic Card */}
              {trainabilityError && trainabilityError.code === "NO_VALID_FEATURES" && (
                <div className="space-y-4">
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      <p className="font-semibold mb-1">As features ficaram constantes após o builder/join.</p>
                      <p className="text-sm text-muted-foreground mb-2">
                        {trainabilityError.features_selected_count || 0} features selecionadas, {trainabilityError.features_blocked_count || 0} bloqueadas.
                      </p>
                      {trainabilityError.top_block_reasons && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {Object.entries(trainabilityError.top_block_reasons).map(([reason, count]) => (
                            <Badge key={reason} variant="outline" className="text-xs">
                              {reason}: {count as number}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {trainabilityError.examples && trainabilityError.examples.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-sm font-medium">Ver colunas constantes ({trainabilityError.examples.length})</summary>
                          <div className="mt-2 max-h-48 overflow-y-auto text-xs space-y-1">
                            {trainabilityError.examples.map((ex) => (
                              <div key={ex.col} className="flex justify-between border-b border-border/30 py-1">
                                <span className="font-mono">{ex.col}</span>
                                <span className="text-muted-foreground">
                                  n_unique={ex.n_unique} | null={ex.pct_null}% | {ex.reason}
                                </span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </AlertDescription>
                  </Alert>
                  <div className="flex gap-2 justify-center">
                    <Button variant="outline" size="sm" onClick={() => { if (onGoToStep) onGoToStep(3); else onBack(); }}>
                      <ArrowLeft className="w-4 h-4 mr-1" /> Revisar entidade/join
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { if (onGoToStep) onGoToStep(4); else onBack(); }}>
                      Re-selecionar features
                    </Button>
                  </div>
                </div>
              )}

              {/* TARGET_TYPE_MISMATCH / LOW_VARIANCE / ONLY_ONE_CLASS Card */}
              {trainabilityError && (trainabilityError.code === "TARGET_TYPE_MISMATCH" || trainabilityError.code === "LOW_VARIANCE_TARGET" || trainabilityError.code === "ONLY_ONE_CLASS" || (trainabilityError.status === "blocked" && !trainabilityError.error_code)) && (
                <div className="space-y-4">
                  <Alert className="bg-amber-500/10 border-amber-500/30">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertDescription>
                      <p className="font-semibold mb-1 text-amber-700">
                        {trainabilityError.code === "TARGET_TYPE_MISMATCH" 
                          ? "Tipo de problema incompatível com o target"
                          : trainabilityError.code === "LOW_VARIANCE_TARGET"
                          ? "Target com variância insuficiente"
                          : trainabilityError.code === "ONLY_ONE_CLASS"
                          ? "Apenas uma classe encontrada"
                          : "Treino bloqueado"}
                      </p>
                      <p className="text-sm text-muted-foreground mb-3">
                        {trainabilityError.message_user || trainabilityError.error || error}
                      </p>
                      {trainabilityError.details && (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {(trainabilityError.details as any)?.distinct_count != null && (
                            <Badge variant="outline" className="text-xs">
                              Valores distintos: {(trainabilityError.details as any).distinct_count}
                            </Badge>
                          )}
                          {(trainabilityError.details as any)?.target_type_real && (
                            <Badge variant="outline" className="text-xs">
                              Tipo detectado: {(trainabilityError.details as any).target_type_real}
                            </Badge>
                          )}
                          {(trainabilityError.details as any)?.sampled?.on && (
                            <Badge className="bg-secondary/20 text-secondary border-secondary/30 text-xs">
                              Treino com amostra (MVP)
                            </Badge>
                          )}
                        </div>
                      )}
                    </AlertDescription>
                  </Alert>
                  <div className="flex gap-2 justify-center flex-wrap">
                    {/* Render fix_suggestions from backend */}
                    {((trainabilityError.details as any)?.fix_suggestions || trainabilityError.fix_suggestions)?.map((fs: any, i: number) => (
                      <Button
                        key={i}
                        variant={i === 0 ? "default" : "outline"}
                        size="sm"
                        onClick={async () => {
                          if (fs.action === "open_diagnostics") {
                            setShowDiagnostics(true);
                            return;
                          }
                          if (fs.action?.startsWith("change_problem_type_")) {
                            const newType = fs.action.replace("change_problem_type_", "") as "classification" | "regression";
                            await saveProject({ problem_type: newType });
                            toast.success(`Tipo alterado para ${newType === "classification" ? "Classificação" : "Regressão"}`);
                            setError(null);
                            setTrainabilityError(null);
                          } else if (fs.action === "open_target_step" || fs.action?.startsWith("open_step_")) {
                            const step = fs.action.startsWith("open_step_") ? parseInt(fs.action.replace("open_step_", ""), 10) : 3;
                            if (onGoToStep && !isNaN(step)) onGoToStep(step); else onBack();
                          } else if (fs.action === "open_human_labeling") {
                            if (onGoToStep) onGoToStep(3); else onBack();
                          }
                        }}
                      >
                        {i === 0 && <Sparkles className="w-4 h-4 mr-1" />}
                        {i > 0 && <ArrowLeft className="w-4 h-4 mr-1" />}
                        {fs.label}
                      </Button>
                    ))}
                    {/* Fallback CTA if no fix_suggestions */}
                    {!((trainabilityError.details as any)?.fix_suggestions || trainabilityError.fix_suggestions)?.length && (
                      <>
                        {(trainabilityError.details as any)?.suggestion && (
                          <Button 
                            variant="default" 
                            size="sm" 
                            onClick={async () => {
                              const suggestion = (trainabilityError.details as any)?.suggestion;
                              if (suggestion) {
                                await saveProject({ problem_type: suggestion as "classification" | "regression" });
                                toast.success(`Tipo alterado para ${suggestion === "classification" ? "Classificação" : "Regressão"}`);
                                setError(null);
                                setTrainabilityError(null);
                              }
                            }}
                          >
                            <Sparkles className="w-4 h-4 mr-1" />
                            Trocar para {(trainabilityError.details as any)?.suggestion === "classification" ? "Classificação" : "Regressão"}
                          </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={() => { if (onGoToStep) onGoToStep(3); else onBack(); }}>
                          <ArrowLeft className="w-4 h-4 mr-1" /> Revisar Target
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {!trainabilityError && (
              <>
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
              </>
              )}
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
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  setTrainingComplete(false);
                  setModels([]);
                  setQualityResult(null);
                  setError(null);
                }}
                className="mt-2"
              >
                <Play className="w-5 h-5 mr-2" />
                Retreinar Modelos
              </Button>
            </div>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════ */}
        {/* BLOCO A — Resultado do Treino                          */}
        {/* ═══════════════════════════════════════════════════════ */}
        {trainingComplete && models.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-primary" />
              <h3 className="font-display font-semibold text-lg">Resultado do Treino</h3>
            </div>

            {/* Unified "Modelo Selecionado" card — merges champion + recommended */}
            {bestModel && (
              <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20 p-6">
                <div className="flex items-start gap-4">
                  <div className="w-14 h-14 bg-gradient-primary rounded-xl flex items-center justify-center flex-shrink-0">
                    <Trophy className="w-7 h-7 text-primary-foreground" />
                  </div>
                  <div className="flex-1 space-y-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-display font-bold text-lg">Modelo Selecionado</h3>
                      {bestModel.is_production && (
                        <Badge className="bg-accent/20 text-accent border-accent/30 text-xs">Em produção</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2 bg-card px-3 py-2 rounded-lg">
                        <Cpu className="w-4 h-4 text-primary" />
                        <span className="font-semibold">{bestModel.algorithm_name}</span>
                      </div>
                      <div className="flex items-center gap-1 bg-accent/20 px-3 py-2 rounded-lg">
                        <span className="font-semibold">{primaryMetric}:</span>
                        <span className="text-accent font-bold">
                          {bestModel.metrics.find(m => m.metric_name === primaryMetric)?.metric_value.toFixed(4) || "—"}
                        </span>
                      </div>
                    </div>
                    {/* Reason for selection */}
                    {recommendedInfo && (
                      <p className="text-sm text-muted-foreground">
                        <strong className="text-foreground">Por que este modelo:</strong>{" "}
                        {recommendedInfo.reason}
                      </p>
                    )}
                    {/* Quality status */}
                    {qualityResult && (
                      <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border/50">
                        <Badge className={qualityResult.can_promote_to_production
                          ? "bg-accent/20 text-accent border-accent/30 text-[10px]"
                          : "bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]"}>
                          {qualityResult.can_promote_to_production ? <CheckCircle className="w-3 h-3 mr-1" /> : <AlertTriangle className="w-3 h-3 mr-1" />}
                          {qualityResult.can_promote_to_production ? "Apto para produção" : "Revisão necessária"}
                        </Badge>
                        <Badge className={qualityResult.metrics_valid
                          ? "bg-accent/20 text-accent border-accent/30 text-[10px]"
                          : "bg-destructive/20 text-destructive border-destructive/30 text-[10px]"}>
                          {qualityResult.metrics_valid ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                          Métricas {qualityResult.metrics_valid ? "válidas" : "inválidas"}
                        </Badge>
                        <Badge className={qualityResult.dashboard_allowed
                          ? "bg-accent/20 text-accent border-accent/30 text-[10px]"
                          : "bg-destructive/20 text-destructive border-destructive/30 text-[10px]"}>
                          {qualityResult.dashboard_allowed ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                          Dashboard {qualityResult.dashboard_allowed ? "liberado" : "bloqueado"}
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            )}

            {/* Zombie model warning */}
            {qualityResult && !qualityResult.dashboard_allowed && (
              <Alert className="bg-destructive/10 border-destructive/30">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                <AlertDescription className="text-xs">
                  ⚠️ Modelo treinado, porém não atingiu qualidade mínima para produção. 
                  {qualityResult.dashboard_allowed_reason && (
                    <span className="font-medium"> Motivo: {qualityResult.dashboard_allowed_reason}.</span>
                  )}
                  {" "}Revise o target e as features e retreine o modelo.
                </AlertDescription>
              </Alert>
            )}

            {/* Training warnings */}
            {qualityResult && qualityResult.training_warnings.length > 0 && qualityResult.dashboard_allowed && (
              <div className="space-y-1 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                {qualityResult.training_warnings.slice(0, 3).map((w, i) => (
                  <p key={i} className="text-[11px] text-amber-600 flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    {w}
                  </p>
                ))}
              </div>
            )}

            {/* Comparação de modelos — collapsible */}
            {models.length > 1 && (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full justify-between text-xs">
                    <span className="flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5" />
                      Comparar todos os modelos ({models.filter(m => m.status === "trained").length})
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <ModelResultsTable 
                    models={models} 
                    problemType={projectData.problem_type} 
                    bestModelId={bestModel?.id}
                  />
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════ */}
        {/* BLOCO B — Interpretação (Lys Insights)                 */}
        {/* ═══════════════════════════════════════════════════════ */}
        {trainingComplete && models.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-secondary" />
              <h3 className="font-display font-semibold text-lg">Interpretação do Modelo</h3>
            </div>

            <UnifiedModelInsights
              projectId={projectData.id || ""}
              modelId={productionModel?.id || bestModel?.id}
              modelName={productionModel?.algorithm_name || bestModel?.algorithm_name}
              problemType={projectData.problem_type}
              models={models}
              bestModelId={bestModel?.id}
              datasetRows={projectData.dataset_rows}
              targetColumn={projectData.target_column}
              showDebug={false}
            />
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════ */}
        {/* BLOCO C — Técnico Avançado (colapsável)                */}
        {/* ═══════════════════════════════════════════════════════ */}
        {trainingComplete && models.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-between text-xs text-muted-foreground border border-border/50">
                <span className="flex items-center gap-1.5">
                  <Settings2 className="w-3.5 h-3.5" />
                  Detalhes Técnicos &amp; Auditoria
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4 space-y-4">
              {/* Quality Gate raw diagnostics */}
              {qualityResult && (
                <div className={`p-4 rounded-lg border space-y-3 ${
                  qualityResult.model_quality_flag === "ok"
                    ? "bg-accent/5 border-accent/20"
                    : qualityResult.model_quality_flag === "weak_model"
                    ? "bg-amber-500/5 border-amber-500/20"
                    : "bg-destructive/5 border-destructive/20"
                }`}>
                  <p className="text-sm font-semibold">Diagnóstico de Qualidade</p>
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
                      {qualityResult.train_diagnostics.raw_metrics_invalid_reasons.length > 0 && (
                        <p className="text-destructive">Métricas inválidas: {qualityResult.train_diagnostics.raw_metrics_invalid_reasons.join("; ")}</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Extended Metrics Report (confusion matrix, threshold curve, etc) */}
              {qualityResult && extendedMetrics && (
                <TrainingMetricsReport
                  metrics={qualityResult.metrics_summary}
                  baselineMetrics={qualityResult.baseline_summary}
                  extended={extendedMetrics}
                  leakageReport={leakageReport}
                  warnings={qualityResult.training_warnings}
                  improvementVsBaseline={qualityResult.improvement_vs_baseline}
                />
              )}

              {/* Training Results Panel — champion/challenger technical view */}
              {qualityResult && (
                <TrainingResultsPanel
                  projectId={projectData.id}
                  problemType={projectData.problem_type}
                  models={(qualityResult as any).ranking || [
                    { model_id: bestModel?.id || "", name: bestModel?.algorithm_name || "", score: bestModel?.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0, sanity: true, is_champion: true, metrics: Object.fromEntries(bestModel?.metrics.map(m => [m.metric_name, m.metric_value]) || []) },
                  ]}
                  champion={(qualityResult as any).champion || (bestModel ? { model_id: bestModel.id, name: bestModel.algorithm_name, score: bestModel.metrics.find(m => m.metric_name === primaryMetric)?.metric_value || 0, sanity: true, is_champion: true, metrics: Object.fromEntries(bestModel.metrics.map(m => [m.metric_name, m.metric_value])) } : null)}
                  calibration={(qualityResult as any).calibration || null}
                  recommendedThreshold={(qualityResult as any).recommended_threshold || null}
                  profile={(qualityResult as any).metrics_profile || null}
                  profileSource={(qualityResult as any).metrics_profile?.source || null}
                  canDeploy={qualityResult.can_promote_to_production}
                />
              )}

              {/* Churn Simulator — only in advanced block when objective is churn/retention */}
              {extendedMetrics && projectData.problem_type === "classification" && 
               contractSummary && (
                 contractSummary.objective === "churn" || 
                 contractSummary.objective === "retention" ||
                 contractSummary.objectiveLabel?.toLowerCase().includes("churn") ||
                 contractSummary.objectiveLabel?.toLowerCase().includes("retenção")
               ) && (
                <ChurnSimulator
                  extendedMetrics={extendedMetrics}
                  totalEntities={trainReadiness?.totalRows || projectData.total_rows || 0}
                />
              )}

              {/* Pipeline Audit Panel */}
              <PipelineAuditPanel projectId={projectData.id || ""} pipelineStage="training" />

            </CollapsibleContent>
          </Collapsible>
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
