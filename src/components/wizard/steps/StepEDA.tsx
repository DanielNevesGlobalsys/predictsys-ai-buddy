import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Database, AlertTriangle, Info, CheckCircle, XCircle, Loader2, RefreshCw, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ProjectData } from "../WizardContainer";
import EDADisplay from "@/components/eda/EDADisplay";
import TDEProfileCard from "./TDEProfileCard";
import LysSynthesisPanel from "./LysSynthesisPanel";
import { supabase } from "@/integrations/supabase/client";
import { trackEvent } from "@/lib/platformTracking";
import { useLysSynthesis } from "@/hooks/useLysSynthesis";

interface StepEDAProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
}

type EdaStatus = "not_started" | "running" | "succeeded" | "failed";

interface EdaSSOT {
  eda_status: EdaStatus;
  eda_error: string | null;
  eda_profile_json: any | null;
  eda_profile_created_at: string | null;
}

const StepEDA = ({ projectData, onNext, onBack, loading }: StepEDAProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { i18n } = useTranslation();
  const [tdeAutoTriggered, setTdeAutoTriggered] = useState<string | null>(null);
  const [tdeRefreshKey, setTdeRefreshKey] = useState(0);
  const lysSynthesis = useLysSynthesis(projectData.id);
  const lysSynthesisTriggered = useRef(false);

  // Dataset state
  const [activeDataset, setActiveDataset] = useState<{ id: string; total_rows: number; columns_count: number; name: string } | null>(null);
  const [datasetLoading, setDatasetLoading] = useState(true);
  const [noDataset, setNoDataset] = useState(false);
  const [isVirtualDataset, setIsVirtualDataset] = useState(false);

  // EDA SSOT state
  const [edaSSOT, setEdaSSOT] = useState<EdaSSOT>({
    eda_status: "not_started",
    eda_error: null,
    eda_profile_json: null,
    eda_profile_created_at: null,
  });
  const [edaCalculating, setEdaCalculating] = useState(false);
  const autoEdaTriggered = useRef(false);

  // Load active dataset + EDA SSOT
  const loadState = useCallback(async () => {
    if (!projectData.id) return;
    setDatasetLoading(true);
    try {
      const [dsResult, settingsResult] = await Promise.all([
        supabase
          .from("project_datasets")
          .select("id, total_rows, columns_count, name, source_type")
          .eq("project_id", projectData.id)
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("project_settings")
          .select("eda_status, eda_error, eda_profile_json, eda_profile_created_at, ingestion_state, ingestion_rows_detected, ingestion_cols_detected, ingestion_source_type")
          .eq("project_id", projectData.id)
          .maybeSingle(),
      ]);

      if (dsResult.data) {
        setActiveDataset(dsResult.data);
        setNoDataset(false);
        // Check if this is a virtual/external dataset (Power BI assisted)
        const srcType = dsResult.data.name?.toLowerCase() || "";
        setIsVirtualDataset(srcType.includes("power bi") || srcType.includes("powerbi"));
      } else {
        // Fallback: check project_settings ingestion_state for assisted/external datasets
        const settings = settingsResult.data as any;
        if (settings?.ingestion_state === 'done' && (settings?.ingestion_rows_detected > 0 || settings?.ingestion_source_type === 'powerbi')) {
          // Dataset was materialized via assisted mode or external connector
          const isVirtual = ['powerbi', 'external'].includes(settings?.ingestion_source_type || '');
          setActiveDataset({
            id: projectData.id,
            total_rows: settings.ingestion_rows_detected || 1,
            columns_count: settings.ingestion_cols_detected || 1,
            name: `Dataset (${settings.ingestion_source_type || 'external'})`,
          });
          setNoDataset(false);
          setIsVirtualDataset(isVirtual);
          console.log("[StepEDA] Using fallback dataset from project_settings ingestion_state=done, virtual=", isVirtual);
        } else {
          setActiveDataset(null);
          setNoDataset(true);
          setIsVirtualDataset(false);
        }
      }

      if (settingsResult.data) {
        setEdaSSOT({
          eda_status: (settingsResult.data as any).eda_status || "not_started",
          eda_error: (settingsResult.data as any).eda_error || null,
          eda_profile_json: (settingsResult.data as any).eda_profile_json || null,
          eda_profile_created_at: (settingsResult.data as any).eda_profile_created_at || null,
        });
      }
    } catch (err) {
      console.warn("[StepEDA] loadState error:", err);
    } finally {
      setDatasetLoading(false);
    }
  }, [projectData.id]);

  useEffect(() => {
    loadState();
    autoEdaTriggered.current = false;
    lysSynthesis.load();
  }, [projectData.id]);

  // Auto-trigger EDA when dataset exists but EDA not yet succeeded
  useEffect(() => {
    if (datasetLoading || !activeDataset || autoEdaTriggered.current) return;
    if (edaSSOT.eda_status === "succeeded" && edaSSOT.eda_profile_json) return;
    if (edaCalculating) return;

    autoEdaTriggered.current = true;
    runEDA();
  }, [datasetLoading, activeDataset, edaSSOT.eda_status, edaCalculating]);

  const runEDA = async () => {
    if (!projectData.id) return;
    setEdaCalculating(true);

    // Update SSOT to running
    await supabase
      .from("project_settings")
      .update({ eda_status: "running", eda_error: null } as any)
      .eq("project_id", projectData.id);
    setEdaSSOT(prev => ({ ...prev, eda_status: "running", eda_error: null }));

    try {
      const { data: responseData, error } = await supabase.functions.invoke("calculate-eda", {
        body: { project_id: projectData.id },
      });
      if (error) throw error;

      // If the response indicates a virtual/external dataset EDA was completed, use it directly
      const isExternalEda = responseData?.is_virtual_dataset || responseData?.eda_status === "completed_external_materialized";
      if (isExternalEda) {
        setIsVirtualDataset(true);
      }

      // Build profile from stats
      const [numResult, catResult] = await Promise.all([
        supabase.from("project_numeric_stats").select("column_name").eq("project_id", projectData.id),
        supabase.from("project_categorical_stats").select("column_name").eq("project_id", projectData.id),
      ]);

      const numCount = numResult.data?.length || 0;
      const catCount = catResult.data?.length || 0;
      const profile = {
        rows_total: activeDataset?.total_rows || 0,
        columns_count: activeDataset?.columns_count || 0,
        numeric_columns: numCount,
        categorical_columns: catCount,
        computed_at: new Date().toISOString(),
      };

      await supabase
        .from("project_settings")
        .update({
          eda_status: "succeeded",
          eda_error: null,
          eda_profile_json: profile,
          eda_profile_created_at: new Date().toISOString(),
        } as any)
        .eq("project_id", projectData.id);

      setEdaSSOT({
        eda_status: "succeeded",
        eda_error: null,
        eda_profile_json: profile,
        eda_profile_created_at: new Date().toISOString(),
      });

      // Track event
      trackEvent({
        event_type: "dataset_profiled",
        project_id: projectData.id,
        status: "success",
        metadata: { rows_total: profile.rows_total, columns_count: profile.columns_count },
      });

      toast({ title: "EDA calculado com sucesso" });

      // Auto-trigger TDE
      handleEDAComplete();
    } catch (err: any) {
      console.error("[StepEDA] EDA failed:", err);
      const errorMsg = err.message || "Erro ao calcular EDA";
      await supabase
        .from("project_settings")
        .update({ eda_status: "failed", eda_error: errorMsg } as any)
        .eq("project_id", projectData.id);
      setEdaSSOT(prev => ({ ...prev, eda_status: "failed", eda_error: errorMsg }));
      toast({ title: "Erro no EDA", description: errorMsg, variant: "destructive" });
    } finally {
      setEdaCalculating(false);
    }
  };

  const handleRecalculate = () => {
    autoEdaTriggered.current = false;
    runEDA();
  };

  const handleEDAComplete = useCallback(async () => {
    const triggerId = projectData.id;
    if (!triggerId || tdeAutoTriggered === triggerId) return;
    setTdeAutoTriggered(triggerId);
    try {
      await supabase.functions.invoke("tde-profile-dataset", {
        body: { project_id: projectData.id },
      });
      setTdeRefreshKey((k) => k + 1);
    } catch (err) {
      console.warn("[StepEDA] TDE auto-trigger failed (non-blocking):", err);
    }
    // Auto-trigger Lys synthesis after TDE
    if (!lysSynthesisTriggered.current) {
      lysSynthesisTriggered.current = true;
      lysSynthesis.generate(i18n.language);
    }
  }, [projectData.id, tdeAutoTriggered, i18n.language]);

  const edaReady = edaSSOT.eda_status === "succeeded" && !!edaSSOT.eda_profile_json;
  const edaRunning = edaSSOT.eda_status === "running" || edaCalculating;
  const canAdvance = edaReady || isVirtualDataset;
  const showTdeAndLys = edaReady || isVirtualDataset;

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">{t("stepEDA.title")}</h2>
          <p className="text-muted-foreground">{t("stepEDA.subtitle")}</p>
        </div>

        {/* Loading */}
        {datasetLoading && (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Verificando dataset…</span>
          </div>
        )}

        {/* No active dataset */}
        {!datasetLoading && noDataset && (
          <div className="p-5 rounded-lg border bg-destructive/10 border-destructive/30 space-y-3">
            <div className="flex items-center gap-3">
              <XCircle className="w-5 h-5 text-destructive" />
              <div>
                <p className="text-sm font-semibold text-destructive">Nenhum dataset ativo registrado</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Reimporte o dataset na etapa anterior para habilitar a análise exploratória.
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" />
              Voltar para Upload
            </Button>
          </div>
        )}

        {/* Dataset found */}
        {!datasetLoading && activeDataset && (
          <>
            {/* Dataset info banner */}
            <div className="p-4 rounded-lg border bg-primary/5 border-primary/20">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <Database className="w-5 h-5 text-primary" />
                  <div>
                    <p className="text-sm font-semibold">Dataset ativo</p>
                    <p className="text-xs text-muted-foreground">
                      {(activeDataset.total_rows || 0).toLocaleString()} linhas • {activeDataset.columns_count || 0} colunas
                      {activeDataset.name ? ` • ${activeDataset.name}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {isVirtualDataset && (
                    <Badge className="bg-secondary/20 text-secondary border-secondary/30 text-[10px]">
                      Externo
                    </Badge>
                  )}
                  {edaReady ? (
                    <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
                      <CheckCircle className="w-3 h-3 mr-1" />
                      EDA: OK
                    </Badge>
                  ) : isVirtualDataset && !edaRunning ? (
                    <Badge className="bg-accent/20 text-accent border-accent/30 text-[10px]">
                      <CheckCircle className="w-3 h-3 mr-1" />
                      Conexão validada
                    </Badge>
                  ) : edaRunning ? (
                    <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px]">
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      Calculando…
                    </Badge>
                  ) : edaSSOT.eda_status === "failed" ? (
                    <Badge variant="destructive" className="text-[10px]">
                      <XCircle className="w-3 h-3 mr-1" />
                      EDA: FALHA
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">Aguardando EDA</Badge>
                  )}
                </div>
              </div>
            </div>

            {/* EDA calculating */}
            {edaRunning && (
              <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                <span className="text-sm font-medium">Calculando EDA automaticamente…</span>
              </div>
            )}

            {/* EDA failed — show retry */}
            {edaSSOT.eda_status === "failed" && !edaRunning && (
              <div className="p-4 rounded-lg border bg-destructive/10 border-destructive/30 space-y-3">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-destructive" />
                  <div>
                    <p className="text-sm font-semibold text-destructive">EDA falhou</p>
                    {edaSSOT.eda_error && (
                      <p className="text-xs text-destructive/80 mt-0.5">{edaSSOT.eda_error}</p>
                    )}
                  </div>
                </div>
                <Button size="sm" onClick={handleRecalculate}>
                  <RefreshCw className="w-4 h-4 mr-1" />
                  Tentar novamente
                </Button>
              </div>
            )}

            {/* Virtual dataset info — Power BI / external */}
            {isVirtualDataset && !edaReady && !edaRunning && (
              <div className="p-4 rounded-lg border bg-secondary/10 border-secondary/30 space-y-2">
                <div className="flex items-center gap-3">
                  <Info className="w-5 h-5 text-secondary" />
                  <div>
                    <p className="text-sm font-semibold">Dataset externo (Power BI)</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Os dados residem na fonte externa. A análise exploratória detalhada estará disponível após a importação completa dos dados. Você pode avançar para a próxima etapa.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* EDA succeeded — show EDADisplay */}
            {edaReady && projectData.id && !isVirtualDataset && (
              <>
                <div className="flex items-center justify-end">
                  <Button variant="outline" size="sm" onClick={handleRecalculate} disabled={edaCalculating}>
                    <RefreshCw className="w-4 h-4 mr-1" />
                    Recalcular
                  </Button>
                </div>
                <EDADisplay
                  projectId={projectData.id}
                  projectName={projectData.name}
                  datasetFilename={projectData.dataset_filename}
                  onEDAComplete={handleEDAComplete}
                />
              </>
            )}

            {/* Info message */}
            <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
              <p className="text-sm text-muted-foreground">
                <strong className="text-secondary">{t("stepEDA.whatIsEDA")}</strong> {t("stepEDA.whatIsEDADesc")}
              </p>
            </div>

            {/* TDE Profile */}
            {projectData.id && showTdeAndLys && (
              <TDEProfileCard key={tdeRefreshKey} projectId={projectData.id} />
            )}

            {/* Lys Synthesis — after EDA + TDE */}
            {projectData.id && showTdeAndLys && (
              <LysSynthesisPanel
                synthesis={{
                  narrative: lysSynthesis.narrative,
                  recommendation: lysSynthesis.recommendation,
                  confidence_score: lysSynthesis.confidence_score,
                  synthesized_at: lysSynthesis.synthesized_at,
                }}
                loading={lysSynthesis.loading}
                generating={lysSynthesis.generating}
                error={lysSynthesis.error}
                onGenerate={() => {
                  lysSynthesisTriggered.current = false;
                  lysSynthesis.generate(i18n.language);
                }}
              />
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
            disabled={loading || noDataset || !canAdvance}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {noDataset ? "Dataset ausente" : edaRunning ? "Calculando EDA…" : canAdvance ? t("common.next") : "Aguardando EDA"}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepEDA;
