import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { 
  Rocket, Globe, Code, Copy, CheckCircle, AlertCircle,
  Loader2, ArrowLeft, ArrowRight, CalendarClock, Mail, Clock,
  Play, RefreshCw, AlertTriangle, XCircle
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ProjectData } from "../WizardContainer";
import ModelResultsTable from "@/components/training/ModelResultsTable";
import PredictionScheduler from "@/components/project/PredictionScheduler";
import DeployAiInsight from "@/components/deploy/DeployAiInsight";

interface ScheduleSummary {
  enabled: boolean;
  frequency: string;
  next_run_at: string | null;
  send_email_to: string;
}

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

interface ScoringState {
  status: "idle" | "running" | "done" | "blocked" | "error";
  batchId: string | null;
  totalScored: number;
  totalExpected: number;
  currentPass: number;
  coveragePct: number;
  errorCode: string | null;
  errorFriendly: string | null;
  warnings: string[];
  ctas: { label: string; go_to_step?: number; action?: string }[];
  missingFeaturePct: number;
}

const StepDeploy = ({ projectData, onBack, onComplete, loading, saveProject }: StepDeployProps) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const [models, setModels] = useState<ModelResult[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [columns, setColumns] = useState<{ column_name: string }[]>([]);
  const [scheduleSummary, setScheduleSummary] = useState<ScheduleSummary | null>(null);
  const scoringAborted = useRef(false);
  const [hasScoringDone, setHasScoringDone] = useState(false);
  const [checkingScoringStatus, setCheckingScoringStatus] = useState(true);

  const [scoring, setScoring] = useState<ScoringState>({
    status: "idle", batchId: null, totalScored: 0, totalExpected: 0,
    currentPass: 0, coveragePct: 0, errorCode: null, errorFriendly: null,
    warnings: [], ctas: [], missingFeaturePct: 0,
  });

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const apiEndpoint = `${supabaseUrl}/functions/v1/predict`;
  const primaryMetric = projectData.problem_type === "classification" ? "AUC" : "R²";

  // Check if project already has valid predictions
  const checkExistingScoring = useCallback(async () => {
    if (!projectData.id) { setCheckingScoringStatus(false); return; }
    setCheckingScoringStatus(true);
    const { count } = await supabase
      .from("predictions")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectData.id)
      .eq("is_latest", true);
    setHasScoringDone((count ?? 0) > 0);
    setCheckingScoringStatus(false);
  }, [projectData.id]);

  useEffect(() => {
    if (projectData.id) {
      loadModels();
      loadColumns();
      loadScheduleSummary();
      checkExistingScoring();
    }
  }, [projectData.id]);

  const loadScheduleSummary = async () => {
    if (!projectData.id) return;
    const { data } = await supabase
      .from("project_prediction_schedules")
      .select("enabled, frequency, next_run_at, send_email_to")
      .eq("project_id", projectData.id).maybeSingle();
    if (data) setScheduleSummary(data);
  };

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
          return { id: model.id, algorithm_name: model.algorithm_name, status: model.status, is_production: model.is_production, metrics: metrics || [] };
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

  const MAX_PASSES = 100;
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  // ===== SCORING MULTI-PASS WITH AUTO-CONTINUE =====
  const runScoring = useCallback(async () => {
    if (!projectData.id || !productionModel) return;

    scoringAborted.current = false;
    setScoring({
      status: "running", batchId: null, totalScored: 0, totalExpected: 0,
      currentPass: 0, coveragePct: 0, errorCode: null, errorFriendly: null,
      warnings: [], ctas: [], missingFeaturePct: 0,
    });

    let passOffset = 0;
    let batchIdToUse: string | undefined;
    let runningStatsState: any = null;
    let totalScoredPrev = 0;
    let totalInvalidPrev = 0;
    let passNumber = 0;
    let jobId: string | undefined;
    const startedAt = Date.now();

    try {
      while (!scoringAborted.current) {
        passNumber++;

        // Safety: max passes
        if (passNumber > MAX_PASSES) {
          setScoring(prev => ({
            ...prev, status: "error",
            errorCode: "SAFE_STOP_MAX_PASSES",
            errorFriendly: `Scoring interrompido após ${MAX_PASSES} passes por segurança. Contate o suporte se o dataset for muito grande.`,
            ctas: [{ label: "Tentar Novamente", action: "retry" }],
          }));
          return;
        }

        // Safety: timeout
        if (Date.now() - startedAt > TIMEOUT_MS) {
          setScoring(prev => ({
            ...prev, status: "error",
            errorCode: "SAFE_STOP_TIMEOUT",
            errorFriendly: "Scoring interrompido após 5 minutos por segurança. Tente novamente ou contate o suporte.",
            ctas: [{ label: "Tentar Novamente", action: "retry" }],
          }));
          return;
        }

        const { data, error: invokeError } = await supabase.functions.invoke('run-batch-predictions', {
          body: {
            project_id: projectData.id,
            horizon_days: 30,
            pass_offset: passOffset,
            batch_id: batchIdToUse,
            running_stats: runningStatsState,
            total_scored_prev: totalScoredPrev,
            total_invalid_prev: totalInvalidPrev,
            job_id: jobId,
          }
        });

        if (invokeError) {
          setScoring(prev => ({
            ...prev, status: "error",
            errorCode: "INVOKE_ERROR", errorFriendly: invokeError.message || "Erro ao chamar scoring",
            ctas: [{ label: "Tentar Novamente", action: "retry" }],
          }));
          return;
        }

        if (data?.status === "BLOCKED") {
          setScoring(prev => ({
            ...prev, status: "blocked",
            errorCode: data.error_code, errorFriendly: data.error_friendly,
            ctas: data.ctas || [],
          }));
          return;
        }

        if (data?.status === "ERROR") {
          setScoring(prev => ({
            ...prev, status: "error",
            errorCode: data.error_code, errorFriendly: data.error_friendly || data.error,
            ctas: data.ctas || [], warnings: data.warnings || [],
          }));
          return;
        }

        // Update progress
        const scored = data?.totals?.rows_scored_total || data?.total_scored_prev || totalScoredPrev + (data?.predictions_generated || 0);
        const estimated = data?.diagnostics?.total_rows_estimated || data?.score_report?.total_rows_expected || 0;
        const coverage = estimated > 0 ? (scored / estimated) * 100 : (scored > 0 ? 100 : 0);

        setScoring(prev => ({
          ...prev,
          batchId: data?.batch_id || prev.batchId,
          totalScored: scored,
          totalExpected: estimated || prev.totalExpected,
          currentPass: passNumber,
          coveragePct: Math.min(100, coverage),
          missingFeaturePct: data?.score_report_partial?.missing_feature_pct || 0,
        }));

        // AUTO-CONTINUE: if backend says CONTINUE, loop automatically
        if (data?.status === "CONTINUE" || data?.continue) {
          passOffset = data.next_offset;
          batchIdToUse = data.batch_id;
          runningStatsState = data.running_stats;
          totalScoredPrev = data.total_scored_prev;
          totalInvalidPrev = data.total_invalid_prev;
          jobId = data.job_id;
          continue; // next iteration — no user click needed
        }

        // DONE
        setScoring(prev => ({
          ...prev,
          status: "done",
          totalScored: data?.predictions_count || data?.rows_scored || scored,
          coveragePct: data?.diagnostics?.coverage_pct || data?.score_report?.coverage_pct || coverage,
          warnings: data?.warnings || [],
          ctas: data?.ctas || [],
        }));

        setHasScoringDone(true);
        toast.success(`✅ ${data?.predictions_count || scored} previsões geradas`);
        return;
      }
    } catch (err) {
      console.error("[Scoring] Client error:", err);
      setScoring(prev => ({
        ...prev, status: "error",
        errorCode: "CLIENT_ERROR",
        errorFriendly: err instanceof Error ? err.message : "Erro inesperado",
        ctas: [{ label: "Tentar Novamente", action: "retry" }],
      }));
    }
  }, [projectData.id, productionModel]);

  const handleCtaClick = (cta: { label: string; go_to_step?: number; action?: string }) => {
    if (cta.action === "retry") {
      runScoring();
    } else if (cta.go_to_step !== undefined) {
      // Navigate to wizard step (0-indexed internally)
      onBack(); // For now, go back; ideally navigate to specific step
    }
  };

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

  const progressPct = scoring.totalExpected > 0
    ? Math.min(100, (scoring.totalScored / scoring.totalExpected) * 100)
    : (scoring.status === "running" ? 50 : 0);

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

        {/* Schedule Summary Banner */}
        {scheduleSummary?.enabled && (
          <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-primary">
              <CalendarClock className="w-5 h-5" />
              <span className="font-medium">{t("stepDeploy.scheduleSummary.title")}</span>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-muted-foreground" />
                <span className="text-muted-foreground">{t("stepDeploy.scheduleSummary.nextRun")}:</span>
                <span className="font-medium">{scheduleSummary.next_run_at ? new Date(scheduleSummary.next_run_at).toLocaleString() : "-"}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Mail className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium">{scheduleSummary.send_email_to}</span>
              </div>
            </div>
          </div>
        )}

        {/* Info */}
        <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-accent">{t("stepDeploy.whatIsDeploy")}</strong> {t("stepDeploy.whatIsDeployDesc")}
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
              bestModelId={bestModel?.id} projectId={projectData.id}
              allowSelectProduction={true} onProductionChange={loadModels}
            />
          </div>
        )}

        {/* ===== SCORING PANEL ===== */}
        {productionModel && (
          <div className="border border-border rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold flex items-center gap-2">
                <Play className="w-4 h-4 text-primary" />
                Gerar Previsões (Scoring)
              </h3>
              <Button
                onClick={runScoring}
                disabled={scoring.status === "running"}
                size="sm"
                className="bg-gradient-primary"
              >
                {scoring.status === "running" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processando...</>
                ) : scoring.status === "done" ? (
                  <><RefreshCw className="w-4 h-4 mr-2" />Rodar Novamente</>
                ) : (
                  <><Play className="w-4 h-4 mr-2" />Gerar Previsões</>
                )}
              </Button>
            </div>

            {/* Progress */}
            {scoring.status === "running" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>
                    Processando lote {scoring.currentPass}
                    {scoring.totalExpected > 0 ? ` de ~${Math.ceil(scoring.totalExpected / 40000)}` : ""}
                    {" — "}{scoring.totalScored.toLocaleString()} previsões geradas
                  </span>
                  <span>{progressPct.toFixed(0)}%</span>
                </div>
                <Progress value={progressPct} className="h-2" />
                {scoring.totalExpected > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Cobertura parcial: {scoring.coveragePct.toFixed(1)}% • {scoring.totalScored.toLocaleString()} / {scoring.totalExpected.toLocaleString()} linhas
                  </p>
                )}
                {scoring.missingFeaturePct > 0 && (
                  <p className="text-xs text-yellow-600 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {scoring.missingFeaturePct.toFixed(0)}% das features ausentes (imputadas)
                  </p>
                )}
              </div>
            )}

            {/* Done */}
            {scoring.status === "done" && (
              <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg space-y-2">
                <div className="flex items-center gap-2 text-accent">
                  <CheckCircle className="w-5 h-5" />
                  <span className="font-medium">
                    {scoring.totalScored.toLocaleString()} previsões geradas — Cobertura: {scoring.coveragePct.toFixed(1)}%
                  </span>
                </div>
                {scoring.warnings.length > 0 && (
                  <div className="space-y-1">
                    {scoring.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-yellow-600 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {w}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Blocked */}
            {scoring.status === "blocked" && (
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg space-y-3">
                <div className="flex items-center gap-2 text-destructive">
                  <XCircle className="w-5 h-5" />
                  <span className="font-medium">Scoring Bloqueado</span>
                  {scoring.errorCode && <Badge variant="outline" className="text-xs">{scoring.errorCode}</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">{scoring.errorFriendly}</p>
                <div className="flex gap-2">
                  {scoring.ctas.map((cta, i) => (
                    <Button key={i} variant="outline" size="sm" onClick={() => handleCtaClick(cta)}>
                      {cta.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {scoring.status === "error" && (
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg space-y-3">
                <div className="flex items-center gap-2 text-destructive">
                  <AlertCircle className="w-5 h-5" />
                  <span className="font-medium">Erro no Scoring</span>
                </div>
                <p className="text-sm text-muted-foreground">{scoring.errorFriendly}</p>
                <div className="flex gap-2">
                  {scoring.ctas.map((cta, i) => (
                    <Button key={i} variant="outline" size="sm" onClick={() => handleCtaClick(cta)}>
                      {cta.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* API info - only show if production model is selected */}
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

            {/* Scheduler - gated behind valid scoring */}
            <div className="pt-4">
              {hasScoringDone ? (
                <PredictionScheduler 
                  projectId={projectData.id!} productionModelName={productionModel.algorithm_name}
                  onScheduleChange={loadScheduleSummary}
                />
              ) : (
                <div className="p-4 bg-muted/30 border border-border rounded-lg flex items-center gap-3">
                  <CalendarClock className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Agendamento automático</p>
                    <p className="text-xs text-muted-foreground">
                      Disponível após a primeira execução de scoring válida. Gere as previsões acima para habilitar.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Post-scoring gate message */}
        {productionModel && !hasScoringDone && scoring.status === "idle" && !checkingScoringStatus && (
          <div className="p-4 bg-muted/20 border border-border rounded-lg flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-muted-foreground shrink-0" />
            <p className="text-sm text-muted-foreground">
              ⚠️ Modelo deployado, mas ainda não existem previsões válidas. Execute o scoring acima para habilitar o Dashboard e o Agendamento.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            <ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}
          </Button>
          <Button
            onClick={onComplete}
            disabled={loading || !productionModel || !hasScoringDone || scoring.status === "running"}
            className="bg-gradient-primary hover:shadow-hover transition-all"
            title={!hasScoringDone ? "Execute o scoring antes de avançar para o Dashboard" : ""}
          >
            {t("common.next")}<ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDeploy;
