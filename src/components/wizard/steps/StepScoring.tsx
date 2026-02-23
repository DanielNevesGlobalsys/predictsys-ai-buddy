import { useState, useEffect, useCallback, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Play, RefreshCw, CheckCircle, AlertCircle, AlertTriangle,
  Loader2, ArrowLeft, ArrowRight, XCircle, BarChart3
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ProjectData } from "../WizardContainer";
import PipelineAuditPanel from "@/components/training/PipelineAuditPanel";

interface StepScoringProps {
  projectData: ProjectData;
  onNext: () => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
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

const MAX_PASSES = 100;
const TIMEOUT_MS = 5 * 60 * 1000;

const StepScoring = ({ projectData, onNext, onBack, loading, saveProject }: StepScoringProps) => {
  const scoringAborted = useRef(false);
  const [hasScoringDone, setHasScoringDone] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [productionModelName, setProductionModelName] = useState<string | null>(null);

  const [failedPromotion, setFailedPromotion] = useState<{ batchId: string; count: number } | null>(null);
  const [promotionRecovering, setPromotionRecovering] = useState(false);

  const [scoring, setScoring] = useState<ScoringState>({
    status: "idle", batchId: null, totalScored: 0, totalExpected: 0,
    currentPass: 0, coveragePct: 0, errorCode: null, errorFriendly: null,
    warnings: [], ctas: [], missingFeaturePct: 0,
  });

  // Check existing predictions + production model + failed/stale state
  useEffect(() => {
    if (!projectData.id) return;
    const init = async () => {
      setCheckingStatus(true);
      const [predRes, modelRes, stateRes] = await Promise.all([
        // Use prediction_state count instead of scanning predictions table
        supabase.from("project_prediction_state").select("predictions_count, latest_batch_id, status")
          .eq("project_id", projectData.id!).maybeSingle(),
        supabase.from("project_models").select("algorithm_name")
          .eq("project_id", projectData.id!).eq("is_production", true).limit(1).maybeSingle(),
        supabase.from("project_prediction_state").select("status, latest_batch_id, predictions_count, last_error_code, last_heartbeat_at, updated_at")
          .eq("project_id", projectData.id!).maybeSingle(),
      ]);
      const predState = predRes.data;
      const latestCount = predState?.predictions_count ?? 0;
      const predStatus = predState?.status;
      setHasScoringDone(latestCount > 0 && (predStatus === 'done' || predStatus === 'sanity_fail'));
      setProductionModelName(modelRes.data?.algorithm_name || null);

      const st = stateRes.data;
      if (st) {
        // Auto-recover stale states: if running/finalizing for >10min, mark as failed
        const isStuck = st.status === "running" || st.status === "finalizing";
        if (isStuck) {
          const heartbeat = st.last_heartbeat_at || st.updated_at;
          const staleMs = heartbeat ? Date.now() - new Date(heartbeat).getTime() : Infinity;
          if (staleMs > 10 * 60 * 1000) {
            // Auto-recover: mark as failed
            await supabase.from("project_prediction_state").update({
              status: "failed",
              last_error_code: "STALE_JOB",
              last_error_message: "Job ficou preso por mais de 10 minutos e foi marcado como falho automaticamente.",
              updated_at: new Date().toISOString(),
            }).eq("project_id", projectData.id!);
            // Refresh state
            st.status = "failed";
            st.last_error_code = "STALE_JOB";
          }
        }

        // Detect failed promotion: state has predictions but none are is_latest
        if (st.status === "failed" && st.predictions_count > 0 && latestCount === 0 && st.latest_batch_id) {
          setFailedPromotion({ batchId: st.latest_batch_id, count: st.predictions_count });
        } else {
          setFailedPromotion(null);
        }
      } else {
        setFailedPromotion(null);
      }

      setCheckingStatus(false);
    };
    init();
  }, [projectData.id]);

  const recoverPromotion = useCallback(async () => {
    if (!failedPromotion || !projectData.id) return;
    setPromotionRecovering(true);
    try {
      const { data, error } = await supabase.functions.invoke("finalize-prediction-promotion", {
        body: { project_id: projectData.id, batch_id: failedPromotion.batchId },
      });
      if (error) throw error;
      if (data?.success) {
        toast.success(`✅ ${failedPromotion.count.toLocaleString()} previsões promovidas com sucesso`);
        setHasScoringDone(true);
        setFailedPromotion(null);
      } else {
        toast.error(data?.message || "Falha ao finalizar promoção");
      }
    } catch (err: any) {
      toast.error(err.message || "Erro ao finalizar promoção");
    } finally {
      setPromotionRecovering(false);
    }
  }, [failedPromotion, projectData.id]);

  const runScoring = useCallback(async () => {
    if (!projectData.id) return;

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

        if (passNumber > MAX_PASSES) {
          setScoring(prev => ({ ...prev, status: "error",
            errorCode: "SAFE_STOP_MAX_PASSES",
            errorFriendly: `Scoring interrompido após ${MAX_PASSES} passes por segurança.`,
            ctas: [{ label: "Tentar Novamente", action: "retry" }],
          }));
          return;
        }

        if (Date.now() - startedAt > TIMEOUT_MS) {
          setScoring(prev => ({ ...prev, status: "error",
            errorCode: "SAFE_STOP_TIMEOUT",
            errorFriendly: "Scoring interrompido após 5 minutos por segurança.",
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
          setScoring(prev => ({ ...prev, status: "error",
            errorCode: "INVOKE_ERROR", errorFriendly: invokeError.message || "Erro ao chamar scoring",
            ctas: [{ label: "Tentar Novamente", action: "retry" }],
          }));
          return;
        }

        if (data?.status === "BLOCKED") {
          setScoring(prev => ({ ...prev, status: "blocked",
            errorCode: data.error_code, errorFriendly: data.error_friendly,
            ctas: data.ctas || [],
          }));
          return;
        }

        if (data?.status === "ERROR") {
          setScoring(prev => ({ ...prev, status: "error",
            errorCode: data.error_code, errorFriendly: data.error_friendly || data.error,
            ctas: data.ctas || [], warnings: data.warnings || [],
          }));
          return;
        }

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

        if (data?.status === "CONTINUE" || data?.continue) {
          passOffset = data.next_offset;
          batchIdToUse = data.batch_id;
          runningStatsState = data.running_stats;
          totalScoredPrev = data.total_scored_prev;
          totalInvalidPrev = data.total_invalid_prev;
          jobId = data.job_id;
          continue;
        }

        // DONE
        setScoring(prev => ({
          ...prev, status: "done",
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
      setScoring(prev => ({ ...prev, status: "error",
        errorCode: "CLIENT_ERROR",
        errorFriendly: err instanceof Error ? err.message : "Erro inesperado",
        ctas: [{ label: "Tentar Novamente", action: "retry" }],
      }));
    }
  }, [projectData.id]);

  const handleCtaClick = (cta: { label: string; go_to_step?: number; action?: string }) => {
    if (cta.action === "retry") runScoring();
    else if (cta.action === "finalize_promotion") recoverPromotion();
    else if (cta.go_to_step !== undefined) saveProject({}, cta.go_to_step);
  };

  const progressPct = scoring.totalExpected > 0
    ? Math.min(100, (scoring.totalScored / scoring.totalExpected) * 100)
    : (scoring.status === "running" ? 50 : 0);

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">Previsões (Scoring)</h2>
          <p className="text-muted-foreground">
            Execute o motor de inferência para gerar previsões sobre todo o dataset.
          </p>
        </div>

        {/* Production model info */}
        {productionModelName && (
          <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-accent" />
            <span className="text-sm">
              Modelo em produção: <strong>{productionModelName}</strong>
            </span>
          </div>
        )}

        {!productionModelName && !checkingStatus && (
          <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-destructive" />
            <span className="text-sm text-destructive">
              Nenhum modelo em produção. Volte à etapa anterior e faça o deploy.
            </span>
          </div>
        )}

        {/* Failed promotion recovery */}
        {failedPromotion && (
          <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg space-y-3">
            <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-400">
              <AlertTriangle className="w-5 h-5" />
              <span className="font-medium">Promoção de batch pendente</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {failedPromotion.count.toLocaleString()} previsões foram geradas (batch {failedPromotion.batchId.slice(0, 8)}…) mas a promoção falhou (timeout). Clique abaixo para finalizar.
            </p>
            <Button
              onClick={recoverPromotion}
              disabled={promotionRecovering}
              size="sm"
              variant="outline"
              className="border-yellow-500/50"
            >
              {promotionRecovering ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Finalizando...</>
              ) : (
                <><RefreshCw className="w-4 h-4 mr-2" />Finalizar Promoção</>
              )}
            </Button>
          </div>
        )}

        {/* Scoring panel */}
        {productionModelName && (
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
                ) : scoring.status === "done" || hasScoringDone ? (
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
            {(scoring.status === "done" || (scoring.status === "idle" && hasScoringDone)) && (
              <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg space-y-2">
                <div className="flex items-center gap-2 text-accent">
                  <CheckCircle className="w-5 h-5" />
                  <span className="font-medium">
                    {scoring.status === "done"
                      ? `${scoring.totalScored.toLocaleString()} previsões geradas — Cobertura: ${scoring.coveragePct.toFixed(1)}%`
                      : "Previsões já existem para este projeto"}
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

        {/* Pipeline Audit Panel */}
        {projectData.id && (
          <PipelineAuditPanel projectId={projectData.id} pipelineStage="production" />
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading || scoring.status === "running"}>
            <ArrowLeft className="w-4 h-4 mr-2" />Voltar
          </Button>
          <Button
            onClick={onNext}
            disabled={loading || !hasScoringDone || scoring.status === "running"}
            className="bg-gradient-primary hover:shadow-hover transition-all"
            title={!hasScoringDone ? "Execute o scoring antes de avançar" : ""}
          >
            Próximo <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepScoring;
