import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LayoutDashboard, ArrowLeft, CheckCircle, Loader2, AlertTriangle, Play, CalendarClock, Bug, RefreshCw, ShieldAlert, Clock, XCircle } from "lucide-react";
import type { ProjectData } from "../WizardContainer";
import { BusinessDashboard } from "@/components/business-dashboard";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useDashboardDataStatus } from "./useDashboardDataStatus";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";

interface StepDashboardProps {
  projectData: ProjectData;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  onFinalComplete: () => Promise<void>;
  onNext?: () => void;
}

const StepDashboard = ({ projectData, onBack, loading, saveProject, onFinalComplete, onNext }: StepDashboardProps) => {
  const { t } = useTranslation();
  const [hasProductionModel, setHasProductionModel] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);

  const dataStatus = useDashboardDataStatus(projectData.id);

  useEffect(() => {
    if (projectData.id) checkProductionModel();
  }, [projectData.id]);

  const checkProductionModel = async () => {
    if (!projectData.id) return;
    const { data } = await supabase
      .from("project_models")
      .select("id")
      .eq("project_id", projectData.id)
      .eq("is_production", true)
      .maybeSingle();
    setHasProductionModel(!!data);
  };

  const handlePromoteBatch = useCallback(async () => {
    if (!projectData.id) return;
    setPromoting(true);
    try {
      // Get current prediction state to find batch_id and counts
      const { data: predState } = await supabase
        .from("project_prediction_state")
        .select("latest_batch_id, predictions_count, coverage_pct")
        .eq("project_id", projectData.id)
        .maybeSingle();

      const batchId = predState?.latest_batch_id;
      if (!batchId) {
        // No batch to promote — run scoring from scratch
        const { data, error } = await supabase.functions.invoke("run-batch-predictions", {
          body: {
            project_id: projectData.id,
            horizon_days: dataStatus.bestHorizon ?? 30,
          },
        });

        if (error) {
          toast.error(`Erro no scoring: ${error.message}`);
        } else if (data?.status === "BLOCKED" || data?.status === "ERROR") {
          toast.error(data.error_friendly || data.error || "Erro no scoring");
        } else {
          toast.success("Scoring finalizado! Recarregando...");
          dataStatus.refetch();
        }
        setPromoting(false);
        return;
      }

      // Call finalize-prediction-promotion (always HTTP 200)
      const { data, error } = await supabase.functions.invoke("finalize-prediction-promotion", {
        body: {
          project_id: projectData.id,
          batch_id: batchId,
          predictions_count: predState?.predictions_count ?? 0,
          coverage_pct: predState?.coverage_pct ?? 0,
        },
      });

      if (error) {
        toast.error(`Erro na promoção: ${error.message}`);
      } else if (data?.success === false) {
        toast.error(data.error_friendly || "Erro na promoção do batch");
      } else {
        toast.success("Promoção concluída! Recarregando...");
      }
      dataStatus.refetch();
    } catch (err) {
      toast.error("Erro inesperado ao promover batch");
      console.error(err);
    } finally {
      setPromoting(false);
    }
  }, [projectData.id, dataStatus.bestHorizon, dataStatus.refetch]);

  const handleCompleteProject = async () => {
    if (!hasProductionModel) {
      toast.error(t("stepDashboard.selectModelFirst"));
      return;
    }
    setCompleting(true);
    try {
      await onFinalComplete();
    } catch (error) {
      console.error("Error completing project:", error);
      toast.error(t("wizard.saveError"));
    } finally {
      setCompleting(false);
    }
  };

  if (!projectData.id) {
    return (
      <Card className="bg-gradient-card shadow-card p-8 text-center">
        <LayoutDashboard className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="font-semibold text-lg mb-2">{t("dashboard.title")}</h3>
        <p className="text-muted-foreground">{t("modelDashboard.completeSteps")}</p>
      </Card>
    );
  }

  // Loading
  if (dataStatus.status === "LOADING") {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Card>
    );
  }

  // Debug panel component
  const DebugPanel = () => (
    <Collapsible open={debugOpen} onOpenChange={setDebugOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground gap-1">
          <Bug className="w-3 h-3" />
          {debugOpen ? "Ocultar diagnóstico" : "Diagnóstico"}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 p-4 bg-muted/50 rounded-lg text-xs font-mono space-y-1 border border-border">
          <p><strong>Status:</strong> {dataStatus.status}</p>
          <p><strong>prediction_state:</strong> {dataStatus.predictionState?.status ?? "N/A"}</p>
          <p><strong>prediction_state.batch_id:</strong> {dataStatus.predictionState?.latest_batch_id ?? "N/A"}</p>
          <p><strong>prediction_state.count:</strong> {dataStatus.predictionState?.predictions_count ?? "N/A"}</p>
          <p><strong>prediction_state.coverage:</strong> {dataStatus.predictionState?.coverage_pct ?? "N/A"}%</p>
          <p><strong>score_report.predictions_count:</strong> {dataStatus.scoreReport?.predictions_count ?? "N/A"}</p>
          <p><strong>score_report.coverage_pct:</strong> {dataStatus.scoreReport?.coverage_pct ?? "N/A"}%</p>
          <p><strong>score_report.batch_id:</strong> {dataStatus.scoreReport?.batch_id ?? "N/A"}</p>
          <p><strong>predictions.total:</strong> {dataStatus.counts.total}</p>
          <p><strong>predictions.latest:</strong> {dataStatus.counts.latest}</p>
          <p><strong>horizons:</strong> {dataStatus.horizons.length > 0 ? dataStatus.horizons.map(h => `${h.horizon_days}d (${h.count})`).join(", ") : "nenhum"}</p>
          <p><strong>bestHorizon:</strong> {dataStatus.bestHorizon ?? "N/A"}</p>
          {dataStatus.predictionState?.last_error_message && <p className="text-destructive"><strong>Error:</strong> {dataStatus.predictionState.last_error_message}</p>}
          {dataStatus.rlsError && <p className="text-destructive"><strong>RLS Error:</strong> {dataStatus.rlsError}</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );

  // RLS error
  if (dataStatus.status === "RLS_ERROR") {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="space-y-6">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto mb-4">
              <ShieldAlert className="w-8 h-8 text-destructive" />
            </div>
            <h2 className="text-2xl font-display font-bold mb-2">Sem permissão</h2>
          </div>
          <div className="p-6 bg-destructive/5 border border-destructive/20 rounded-xl text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              Não foi possível ler as previsões. Verifique suas permissões de acesso (RLS).
            </p>
            <pre className="text-xs text-left bg-muted p-3 rounded overflow-auto max-h-32">{dataStatus.rlsError}</pre>
          </div>
          <DebugPanel />
          <div className="flex justify-between pt-6 border-t border-border">
            <Button variant="outline" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}</Button>
          </div>
        </div>
      </Card>
    );
  }

  // Scoring running
  if (dataStatus.status === "SCORING_RUNNING") {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="space-y-6">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <h2 className="text-2xl font-display font-bold mb-2">Gerando previsões…</h2>
          </div>
          <div className="p-6 bg-primary/5 border border-primary/20 rounded-xl text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              O scoring está processando o dataset em múltiplos passes. Isso pode levar alguns minutos.
            </p>
            <Button variant="outline" size="sm" onClick={dataStatus.refetch}>
              <RefreshCw className="w-4 h-4 mr-2" />Atualizar status
            </Button>
          </div>
          <DebugPanel />
          <div className="flex justify-between pt-6 border-t border-border">
            <Button variant="outline" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}</Button>
          </div>
        </div>
      </Card>
    );
  }

  // Scoring finalizing
  if (dataStatus.status === "SCORING_FINALIZING") {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="space-y-6">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-accent/50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Clock className="w-8 h-8 text-accent-foreground" />
            </div>
            <h2 className="text-2xl font-display font-bold mb-2">Finalizando previsões…</h2>
          </div>
          <div className="p-6 bg-accent/50 border border-accent rounded-xl text-center space-y-4">
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              As previsões foram geradas e estão sendo promovidas. Se isso demorar, clique para finalizar manualmente.
            </p>
            <Button onClick={handlePromoteBatch} disabled={promoting} className="bg-gradient-primary">
              {promoting ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Finalizando…</>
              ) : (
                <><RefreshCw className="w-4 h-4 mr-2" />Finalizar scoring</>
              )}
            </Button>
          </div>
          <DebugPanel />
          <div className="flex justify-between pt-6 border-t border-border">
            <Button variant="outline" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}</Button>
          </div>
        </div>
      </Card>
    );
  }

  // Scoring failed
  if (dataStatus.status === "SCORING_FAILED") {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="space-y-6">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-destructive/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <XCircle className="w-8 h-8 text-destructive" />
            </div>
            <h2 className="text-2xl font-display font-bold mb-2">Scoring falhou</h2>
          </div>
          <div className="p-6 bg-destructive/5 border border-destructive/20 rounded-xl text-center space-y-4">
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Ocorreu um erro durante o scoring. {dataStatus.predictionState?.last_error_message || "Tente novamente."}
            </p>
            {dataStatus.predictionState?.last_error_code && (
              <Badge variant="outline" className="text-xs">{dataStatus.predictionState.last_error_code}</Badge>
            )}
            <div>
              <Button onClick={handlePromoteBatch} disabled={promoting} variant="outline">
                <RefreshCw className="w-4 h-4 mr-2" />Tentar novamente
              </Button>
            </div>
          </div>
          <DebugPanel />
          <div className="flex justify-between pt-6 border-t border-border">
            <Button variant="outline" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}</Button>
          </div>
        </div>
      </Card>
    );
  }

  // Pending promote: predictions exist but none is_latest
  if (dataStatus.status === "PENDING_PROMOTE") {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="space-y-6">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto mb-4">
              <LayoutDashboard className="w-8 h-8 text-muted-foreground" />
            </div>
            <h2 className="text-2xl font-display font-bold mb-2">{t("modelDashboard.title")}</h2>
          </div>
          <div className="p-6 bg-accent/50 border border-accent rounded-xl text-center space-y-4">
            <AlertTriangle className="w-10 h-10 text-accent-foreground mx-auto" />
            <h3 className="font-semibold text-lg">Previsões não promovidas</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Existem <strong>{dataStatus.counts.total}</strong> previsões geradas, mas nenhuma está marcada como <Badge variant="outline" className="text-xs">is_latest</Badge>. 
              Finalize o scoring para promover o batch.
            </p>
            <Button onClick={handlePromoteBatch} disabled={promoting} className="bg-gradient-primary">
              {promoting ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processando scoring...</>
              ) : (
                <><RefreshCw className="w-4 h-4 mr-2" />Finalizar scoring (promover batch)</>
              )}
            </Button>
          </div>
          <DebugPanel />
          <div className="flex justify-between pt-6 border-t border-border">
            <Button variant="outline" onClick={onBack} disabled={loading || promoting}>
              <ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // No predictions at all
  if (dataStatus.status === "NO_PREDICTIONS") {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="space-y-6">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto mb-4">
              <LayoutDashboard className="w-8 h-8 text-muted-foreground" />
            </div>
            <h2 className="text-2xl font-display font-bold mb-2">{t("modelDashboard.title")}</h2>
          </div>
          <div className="p-6 bg-destructive/5 border border-destructive/20 rounded-xl text-center space-y-4">
            <AlertTriangle className="w-10 h-10 text-destructive mx-auto" />
            <h3 className="font-semibold text-lg">Dashboard não disponível</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Nenhuma previsão foi encontrada. Execute o Scoring na etapa anterior para gerar previsões.
            </p>
            <Button variant="outline" onClick={onBack} className="mt-2">
              <Play className="w-4 h-4 mr-2" />Voltar ao Scoring
            </Button>
          </div>
          <DebugPanel />
          <div className="flex justify-between pt-6 border-t border-border">
            <Button variant="outline" onClick={onBack} disabled={loading}>
              <ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // OK — show dashboard
  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <LayoutDashboard className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">{t("modelDashboard.title")}</h2>
          <p className="text-muted-foreground">{t("modelDashboard.subtitle")}</p>
        </div>

        <BusinessDashboard projectId={projectData.id} />

        <DebugPanel />

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading || completing}>
            <ArrowLeft className="w-4 h-4 mr-2" />{t("common.back")}
          </Button>
          <div className="flex gap-2">
            {onNext && (
              <Button variant="outline" onClick={onNext} disabled={loading || completing}>
                Agendamento
                <CalendarClock className="w-4 h-4 ml-2" />
              </Button>
            )}
            <Button
              onClick={handleCompleteProject}
              disabled={loading || completing || !hasProductionModel}
              className="bg-gradient-primary hover:shadow-hover transition-all"
            >
              {completing ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("common.loading")}</>
              ) : (
                <><CheckCircle className="w-4 h-4 mr-2" />{t("stepDashboard.completeProject")}</>
              )}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default StepDashboard;
