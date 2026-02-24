import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Database, AlertTriangle, Info, CheckCircle, XCircle, Loader2, RefreshCw, ArrowLeft } from "lucide-react";
import type { ProjectData } from "../WizardContainer";
import EDADisplay from "@/components/eda/EDADisplay";
import { useDatasetState } from "@/hooks/useDatasetState";
import TDEProfileCard from "./TDEProfileCard";
import { supabase } from "@/integrations/supabase/client";

interface StepEDAProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
}

type SchemaStatus = "OK" | "WARN" | "INTERSECTION" | "ANCHOR";

type IngestionState = "idle" | "running" | "done" | "failed" | null;

interface IngestionSSOT {
  ingestion_state: IngestionState;
  ingestion_error_code: string | null;
  ingestion_error_message: string | null;
  ingestion_manifest_id: string | null;
  ingestion_dataset_id: string | null;
}

const STRATEGY_MESSAGES: Record<string, string> = {
  UNION_BY_NAME: "Schema divergente detectado. A EDA foi executada em modo compatível (união por colunas — NULLs podem aparecer).",
  INTERSECTION_ONLY: "EDA executada em modo interseção devido a divergência de schemas (somente colunas comuns).",
  ANCHOR_FILE_EDA: "EDA executada no dataset âncora devido à presença exclusiva do target.",
};

const STRATEGY_MESSAGES_OK: Record<string, string> = {
  UNION_BY_NAME: "Dataset consolidado com sucesso. Todas as colunas disponíveis para análise.",
  INTERSECTION_ONLY: "EDA disponível (somente colunas comuns entre todos os arquivos).",
  ANCHOR_FILE_EDA: "EDA parcial (arquivo âncora).",
};

const StepEDA = ({ projectData, onNext, onBack, loading }: StepEDAProps) => {
  const { t } = useTranslation();
  const ds = useDatasetState(projectData.id);
  const [tdeAutoTriggered, setTdeAutoTriggered] = useState<string | null>(null);
  const [tdeRefreshKey, setTdeRefreshKey] = useState(0);

  // ── Ingestion SSOT gate ──────────────────────────────────
  const [ingestion, setIngestion] = useState<IngestionSSOT>({
    ingestion_state: null,
    ingestion_error_code: null,
    ingestion_error_message: null,
    ingestion_manifest_id: null,
    ingestion_dataset_id: null,
  });
  const [ingestionLoading, setIngestionLoading] = useState(true);
  const [repairLoading, setRepairLoading] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadIngestionState = useCallback(async () => {
    if (!projectData.id) return;
    try {
      const { data } = await supabase
        .from("project_settings")
        .select("ingestion_state, ingestion_error_code, ingestion_error_message, ingestion_manifest_id, ingestion_dataset_id")
        .eq("project_id", projectData.id)
        .maybeSingle();
      if (data) {
        setIngestion({
          ingestion_state: (data.ingestion_state as IngestionState) || "idle",
          ingestion_error_code: data.ingestion_error_code,
          ingestion_error_message: data.ingestion_error_message,
          ingestion_manifest_id: data.ingestion_manifest_id,
          ingestion_dataset_id: data.ingestion_dataset_id,
        });
      }
    } catch (err) {
      console.warn("[StepEDA] Failed to load ingestion state:", err);
    } finally {
      setIngestionLoading(false);
    }
  }, [projectData.id]);

  useEffect(() => {
    if (projectData.id) {
      ds.load();
      setTdeAutoTriggered(null);
      setIngestionLoading(true);
      loadIngestionState();
    }
  }, [projectData.id]);

  // Polling when running
  useEffect(() => {
    if (ingestion.ingestion_state === "running") {
      pollingRef.current = setInterval(loadIngestionState, 7000);
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [ingestion.ingestion_state, loadIngestionState]);

  const ingestionReady = ingestion.ingestion_state === "done";
  const ingestionRunning = ingestion.ingestion_state === "running";
  const ingestionFailed = ingestion.ingestion_state === "failed";
  const ingestionIdle = ingestion.ingestion_state === "idle" || ingestion.ingestion_state === null;
  const manifestMissing = ingestionReady && !ingestion.ingestion_manifest_id;

  // Auto-repair handler
  const handleRepairManifest = useCallback(async () => {
    if (!projectData.id || repairLoading) return;
    setRepairLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("repair-ingestion-manifest", {
        body: { project_id: projectData.id },
      });
      if (error) throw error;
      const result = data as Record<string, unknown>;
      if (result?.success) {
        console.log("[StepEDA] Manifest repaired:", result);
        await loadIngestionState();
        ds.load();
      } else {
        console.error("[StepEDA] Manifest repair failed:", result);
        // If repair failed and state is now 'failed', the UI will show the failed state
        await loadIngestionState();
      }
    } catch (err) {
      console.error("[StepEDA] Manifest repair error:", err);
    } finally {
      setRepairLoading(false);
    }
  }, [projectData.id, repairLoading, loadIngestionState, ds]);

  // Auto-trigger TDE profile after EDA completes (idempotent, best-effort)
  const handleEDAComplete = useCallback(async () => {
    const triggerId = projectData.id;
    if (!triggerId || tdeAutoTriggered === triggerId) return;
    setTdeAutoTriggered(triggerId);
    try {
      await supabase.functions.invoke("tde-profile-dataset", {
        body: { project_id: projectData.id },
      });
      // Refresh the TDE card to show updated data
      setTdeRefreshKey((k) => k + 1);
      console.log("[StepEDA] TDE profile auto-triggered after EDA");
    } catch (err) {
      // Best-effort: don't block the flow, user can manually refresh via TDE card
      console.warn("[StepEDA] TDE auto-trigger failed (non-blocking):", err);
    }
  }, [projectData.id, tdeAutoTriggered]);

  const edaBlocked = ds.loaded ? !ds.edaReady : false;
  const edaStrategy = ds.fallback?.edaStrategy || "UNION_BY_NAME";

  const deriveSchemaStatus = (): SchemaStatus => {
    if (edaStrategy === "INTERSECTION_ONLY") return "INTERSECTION";
    if (edaStrategy === "ANCHOR_FILE_EDA") return "ANCHOR";
    if ((ds.fallback?.filesWarn || 0) > 0 || ds.fallback?.manifestStatus === "warn") return "WARN";
    return "OK";
  };

  const schemaStatus = ds.loaded ? deriveSchemaStatus() : "OK";
  const hasSchemaIssue = schemaStatus !== "OK";
  const strategyMsg = ds.loaded
    ? (hasSchemaIssue
        ? STRATEGY_MESSAGES[edaStrategy] || ""
        : STRATEGY_MESSAGES_OK[edaStrategy] || "")
    : "";
  const edaScope = ds.fallback?.edaScope || null;
  const blockedReasonEda = ds.fallback?.blockedReasonEda || null;
  const blockedReasonModel = ds.fallback?.blockedReasonModel || null;
  const sourceLabel = ds.sourceType !== "upload" ? `Fonte: ${ds.sourceType.toUpperCase()}` : undefined;

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            {t("stepEDA.title")}
          </h2>
          <p className="text-muted-foreground">
            {t("stepEDA.subtitle")}
          </p>
        </div>

        {/* ── Ingestion Gate ─────────────────────────────── */}
        {ingestionLoading && (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Verificando estado da ingestão…</span>
          </div>
        )}

        {!ingestionLoading && !ingestionReady && (
          <div className={`p-5 rounded-lg border space-y-3 ${
            ingestionFailed ? "bg-destructive/10 border-destructive/30" :
            ingestionRunning ? "bg-primary/5 border-primary/20" :
            "bg-muted/50 border-border"
          }`}>
            <div className="flex items-center gap-3">
              {ingestionRunning ? (
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              ) : ingestionFailed ? (
                <XCircle className="w-5 h-5 text-destructive" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-muted-foreground" />
              )}
              <div>
                <p className="text-sm font-semibold">
                  {ingestionRunning && "Ingestão em andamento…"}
                  {ingestionFailed && "Ingestão falhou"}
                  {ingestionIdle && "Ingestão ainda não executada"}
                </p>
                {ingestionFailed && ingestion.ingestion_error_code && (
                  <p className="text-xs text-destructive/80 mt-0.5">
                    [{ingestion.ingestion_error_code}] {ingestion.ingestion_error_message || "Erro durante a importação."}
                  </p>
                )}
                {ingestionRunning && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    A análise exploratória ficará disponível quando a importação for concluída.
                  </p>
                )}
                {ingestionIdle && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Importe seus dados na etapa anterior para habilitar a análise exploratória.
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={onBack}>
                <ArrowLeft className="w-3.5 h-3.5 mr-1" />
                Voltar para Upload
              </Button>
              {ingestionRunning && (
                <Button variant="ghost" size="sm" onClick={loadIngestionState}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1" />
                  Atualizar status
                </Button>
              )}
              {ingestionFailed && (
                <Button variant="ghost" size="sm" onClick={onBack}>
                  Tentar novamente
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Manifest missing — blocking with auto-repair CTA */}
        {!ingestionLoading && manifestMissing && (
          <div className="p-5 rounded-lg border space-y-3 bg-amber-500/5 border-amber-500/20">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-amber-700">Importação incompleta: manifest ausente</p>
                <p className="text-xs text-amber-600/80 mt-0.5">
                  O dataset foi importado, mas sem registro de manifest estruturado. A análise exploratória requer um manifest válido.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRepairManifest}
                disabled={repairLoading}
              >
                {repairLoading ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mr-1" />
                )}
                {repairLoading ? "Reconstruindo…" : "Reconstruir manifest"}
              </Button>
              <Button variant="ghost" size="sm" onClick={onBack}>
                <ArrowLeft className="w-3.5 h-3.5 mr-1" />
                Reimportar dados
              </Button>
            </div>
          </div>
        )}
        {/* ── Content only when ingestion is done ──────── */}
        {ingestionReady && !manifestMissing && (
          <>
            {/* Consolidated Dataset Banner */}
            {ds.loaded && ds.rowCount > 0 && (
              <div className={`p-4 rounded-lg border space-y-3 ${
                edaBlocked
                  ? "bg-destructive/10 border-destructive/30"
                  : hasSchemaIssue
                    ? "bg-amber-500/5 border-amber-500/20"
                    : "bg-primary/5 border-primary/20"
              }`}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <Database className={`w-5 h-5 ${edaBlocked ? "text-destructive" : "text-primary"}`} />
                    <div>
                      {edaBlocked ? (
                        <p className="text-sm font-semibold text-destructive">
                          Não há dados suficientes para análise exploratória
                        </p>
                      ) : (
                        <>
                          <p className="text-sm font-semibold">Dataset consolidado {ds.isVirtual && <Badge variant="outline" className="ml-2 text-[10px]">virtual</Badge>}</p>
                          <p className="text-xs text-muted-foreground">
                            {ds.rowCount.toLocaleString()} linhas • {ds.colCount} colunas
                            {sourceLabel && ` • ${sourceLabel}`}
                            {!ds.isVirtual && ds.fallback?.totalFiles ? ` • ${ds.fallback.totalFiles} arquivo(s)` : ""}
                          </p>
                        </>
                      )}
                      {edaBlocked && blockedReasonEda && (
                        <p className="text-xs text-destructive/80 mt-0.5">{blockedReasonEda}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {edaBlocked ? (
                      <Badge variant="destructive" className="text-[10px]">
                        <XCircle className="w-3 h-3 mr-1" />
                        EDA: BLOCKED
                      </Badge>
                    ) : (
                      <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        EDA: OK
                      </Badge>
                    )}

                    {ds.modelReady ? (
                      <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        MODEL: OK
                      </Badge>
                    ) : !edaBlocked ? (
                      <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        MODEL: WARN
                      </Badge>
                    ) : null}

                    {schemaStatus === "OK" ? (
                      <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
                        SCHEMA: OK
                      </Badge>
                    ) : schemaStatus === "WARN" ? (
                      <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">
                        SCHEMA: WARN
                      </Badge>
                    ) : schemaStatus === "INTERSECTION" ? (
                      <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">
                        SCHEMA: INTERSECTION
                      </Badge>
                    ) : (
                      <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30 text-[10px]">
                        SCHEMA: ANCHOR
                      </Badge>
                    )}
                  </div>
                </div>

                {!edaBlocked && strategyMsg && (
                  <div className={`flex items-start gap-2 text-xs p-2 rounded ${
                    hasSchemaIssue
                      ? "text-amber-700 bg-amber-500/10 border border-amber-500/20"
                      : "text-muted-foreground bg-muted/30"
                  }`}>
                    <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>
                      {strategyMsg}
                      {edaStrategy === "ANCHOR_FILE_EDA" && edaScope ? ` (${edaScope})` : ""}
                    </span>
                  </div>
                )}

                {!edaBlocked && !ds.modelReady && blockedReasonModel && (
                  <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/5 p-2 rounded border border-amber-500/20">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>Modelagem bloqueada: {blockedReasonModel}</span>
                  </div>
                )}
              </div>
            )}

            {/* Info message */}
            <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
              <p className="text-sm text-muted-foreground">
                <strong className="text-secondary">{t("stepEDA.whatIsEDA")}</strong> {t("stepEDA.whatIsEDADesc")}
              </p>
            </div>

            {/* EDA Display */}
            {edaBlocked ? (
              <div className="text-center py-12 space-y-3">
                <XCircle className="w-12 h-12 text-destructive/50 mx-auto" />
                <p className="text-muted-foreground font-medium">
                  Não é possível executar a análise exploratória.
                </p>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  {blockedReasonEda || "O dataset não contém dados válidos (0 linhas ou 0 colunas). Volte à etapa anterior e corrija a importação."}
                </p>
              </div>
            ) : projectData.id ? (
              <EDADisplay 
                projectId={projectData.id} 
                projectName={projectData.name}
                datasetFilename={projectData.dataset_filename}
                onEDAComplete={handleEDAComplete} 
              />
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                {t("stepEDA.saveProjectFirst")}
              </div>
            )}

            {/* TDE Profile */}
            {projectData.id && !edaBlocked && (
              <TDEProfileCard key={tdeRefreshKey} projectId={projectData.id} />
            )}
          </>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            {t("common.back")}
          </Button>
          <Button
            onClick={() => onNext({ status: "eda_complete" })}
            disabled={loading || edaBlocked || !ingestionReady || manifestMissing}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {!ingestionReady ? "Aguardando ingestão" : manifestMissing ? "Manifest ausente" : edaBlocked ? "Corrigir importação" : t("common.next")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepEDA;
