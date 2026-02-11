import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Database, AlertTriangle, Info } from "lucide-react";
import type { ProjectData } from "../WizardContainer";
import EDADisplay from "@/components/eda/EDADisplay";
import { supabase } from "@/integrations/supabase/client";

interface StepEDAProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
}

interface DatasetBannerInfo {
  totalRows: number;
  columnsCount: number;
  totalFiles: number;
  edaReady: boolean;
  modelReady: boolean;
  edaStrategy: string;
  edaScope: string | null;
  blockedReasonEda: string | null;
  blockedReasonModel: string | null;
  manifestStatus: string;
}

const EDA_STRATEGY_MESSAGES: Record<string, string> = {
  UNION_BY_NAME: "EDA disponível (união por colunas). Atenção: schemas divergentes podem gerar NULLs.",
  INTERSECTION_ONLY: "EDA disponível (somente colunas comuns entre todos os arquivos).",
  ANCHOR_FILE_EDA: "EDA parcial (arquivo âncora).",
};

const StepEDA = ({ projectData, onNext, onBack, loading }: StepEDAProps) => {
  const { t } = useTranslation();
  const [bannerInfo, setBannerInfo] = useState<DatasetBannerInfo | null>(null);

  useEffect(() => {
    if (!projectData.id) return;

    const loadBannerInfo = async () => {
      // Get latest manifest with new fields
      const { data: manifest } = await supabase
        .from("import_manifests")
        .select("rows_consolidated, columns_final, total_files, status, status_reason, eda_ready, model_ready, eda_strategy, eda_scope, blocked_reason_eda, blocked_reason_model")
        .eq("project_id", projectData.id!)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (manifest) {
        // Use new eda_ready field; fallback to old logic for backward compat
        const edaReady = manifest.eda_ready !== false;
        const modelReady = manifest.model_ready !== false;

        setBannerInfo({
          totalRows: manifest.rows_consolidated,
          columnsCount: manifest.columns_final,
          totalFiles: manifest.total_files,
          edaReady,
          modelReady,
          edaStrategy: (manifest.eda_strategy as string) || "UNION_BY_NAME",
          edaScope: manifest.eda_scope as string | null,
          blockedReasonEda: manifest.blocked_reason_eda as string | null,
          blockedReasonModel: manifest.blocked_reason_model as string | null,
          manifestStatus: manifest.status,
        });
      } else {
        // No manifest — use project data fallback
        setBannerInfo({
          totalRows: projectData.total_rows || projectData.dataset_rows || 0,
          columnsCount: projectData.dataset_columns || 0,
          totalFiles: 1,
          edaReady: true,
          modelReady: true,
          edaStrategy: "UNION_BY_NAME",
          edaScope: null,
          blockedReasonEda: null,
          blockedReasonModel: null,
          manifestStatus: "ok",
        });
      }
    };

    loadBannerInfo();
  }, [projectData.id, projectData.total_rows, projectData.dataset_rows, projectData.dataset_columns]);

  const handleEDAComplete = () => {};

  const edaBlocked = bannerInfo ? !bannerInfo.edaReady : false;
  const strategyMsg = bannerInfo ? EDA_STRATEGY_MESSAGES[bannerInfo.edaStrategy] || "" : "";

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

        {/* Consolidated Dataset Banner */}
        {bannerInfo && (
          <div className={`p-4 rounded-lg border space-y-2 ${
            edaBlocked
              ? "bg-destructive/10 border-destructive/30"
              : "bg-primary/5 border-primary/20"
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Database className={`w-5 h-5 ${edaBlocked ? "text-destructive" : "text-primary"}`} />
                <div>
                  {edaBlocked ? (
                    <p className="text-sm font-semibold text-destructive">Dataset não disponível para análise</p>
                  ) : (
                    <>
                      <p className="text-sm font-semibold">Dataset consolidado</p>
                      <p className="text-xs text-muted-foreground">
                        {bannerInfo.totalRows.toLocaleString()} linhas • {bannerInfo.columnsCount} colunas • {bannerInfo.totalFiles} arquivo(s)
                      </p>
                    </>
                  )}
                  {edaBlocked && bannerInfo.blockedReasonEda && (
                    <p className="text-xs text-destructive/80 mt-0.5">{bannerInfo.blockedReasonEda}</p>
                  )}
                </div>
              </div>

              {/* Separate EDA / MODEL badges */}
              <div className="flex items-center gap-2">
                {edaBlocked ? (
                  <Badge variant="destructive">EDA: BLOCKED</Badge>
                ) : bannerInfo.manifestStatus === "warn" ? (
                  <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">
                    <AlertTriangle className="w-3 h-3 mr-1" />
                    EDA: APPROVED
                  </Badge>
                ) : (
                  <Badge className="bg-accent/20 text-accent border-accent/30">EDA: APPROVED</Badge>
                )}

                {bannerInfo.modelReady ? (
                  <Badge className="bg-accent/20 text-accent border-accent/30">MODEL: APPROVED</Badge>
                ) : !edaBlocked ? (
                  <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">
                    <AlertTriangle className="w-3 h-3 mr-1" />
                    MODEL: BLOCKED
                  </Badge>
                ) : null}
              </div>
            </div>

            {/* Strategy message */}
            {!edaBlocked && strategyMsg && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded">
                <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{strategyMsg}{bannerInfo.edaStrategy === "ANCHOR_FILE_EDA" && bannerInfo.edaScope ? ` (${bannerInfo.edaScope})` : ""}</span>
              </div>
            )}

            {/* Model blocked reason (shown only when EDA is ok but model is not) */}
            {!edaBlocked && !bannerInfo.modelReady && bannerInfo.blockedReasonModel && (
              <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/5 p-2 rounded border border-amber-500/20">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>Modelagem bloqueada: {bannerInfo.blockedReasonModel}</span>
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
            <AlertTriangle className="w-12 h-12 text-destructive/50 mx-auto" />
            <p className="text-muted-foreground font-medium">
              Não é possível executar a análise exploratória.
            </p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {bannerInfo?.blockedReasonEda || "O dataset importado possui problemas estruturais que impedem a análise. Volte à etapa anterior e corrija a importação."}
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

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            {t("common.back")}
          </Button>
          <Button
            onClick={() => onNext({ status: "eda_complete" })}
            disabled={loading || edaBlocked}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {edaBlocked ? "Corrigir importação" : t("common.next")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepEDA;
