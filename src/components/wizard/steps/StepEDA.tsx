import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Database, FileSpreadsheet, AlertTriangle } from "lucide-react";
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
  manifestStatus: string;
  manifestReason: string | null;
}

const StepEDA = ({ projectData, onNext, onBack, loading }: StepEDAProps) => {
  const { t } = useTranslation();
  const [bannerInfo, setBannerInfo] = useState<DatasetBannerInfo | null>(null);
  const [hasValidDataset, setHasValidDataset] = useState(true);

  useEffect(() => {
    if (!projectData.id) return;

    const loadBannerInfo = async () => {
      // Get latest manifest
      const { data: manifest } = await supabase
        .from("import_manifests")
        .select("rows_consolidated, columns_final, total_files, status, status_reason")
        .eq("project_id", projectData.id!)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (manifest) {
        setBannerInfo({
          totalRows: manifest.rows_consolidated,
          columnsCount: manifest.columns_final,
          totalFiles: manifest.total_files,
          manifestStatus: manifest.status,
          manifestReason: manifest.status_reason,
        });
        setHasValidDataset(manifest.status !== "blocked" && manifest.status !== "fail");
      } else {
        // Fallback to project data
        setBannerInfo({
          totalRows: projectData.total_rows || projectData.dataset_rows || 0,
          columnsCount: projectData.dataset_columns || 0,
          totalFiles: 1,
          manifestStatus: "ok",
          manifestReason: null,
        });
      }
    };

    loadBannerInfo();
  }, [projectData.id, projectData.total_rows, projectData.dataset_rows, projectData.dataset_columns]);

  const handleEDAComplete = () => {};

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
          <div className={`flex items-center justify-between p-4 rounded-lg border ${
            !hasValidDataset
              ? "bg-destructive/10 border-destructive/30"
              : "bg-primary/5 border-primary/20"
          }`}>
            <div className="flex items-center gap-3">
              <Database className={`w-5 h-5 ${!hasValidDataset ? "text-destructive" : "text-primary"}`} />
              <div>
                <p className="text-sm font-semibold">
                  {!hasValidDataset ? (
                    <span className="text-destructive">Dataset não disponível para análise</span>
                  ) : (
                    <>Dataset consolidado</>
                  )}
                </p>
                {hasValidDataset && (
                  <p className="text-xs text-muted-foreground">
                    {bannerInfo.totalRows.toLocaleString()} linhas • {bannerInfo.columnsCount} colunas • {bannerInfo.totalFiles} arquivo(s)
                  </p>
                )}
                {!hasValidDataset && bannerInfo.manifestReason && (
                  <p className="text-xs text-destructive/80 mt-0.5">{bannerInfo.manifestReason}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {bannerInfo.manifestStatus === "ok" && (
                <Badge className="bg-accent/20 text-accent border-accent/30">APPROVED</Badge>
              )}
              {bannerInfo.manifestStatus === "warn" && (
                <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  APPROVED
                </Badge>
              )}
              {(bannerInfo.manifestStatus === "blocked" || bannerInfo.manifestStatus === "fail") && (
                <Badge variant="destructive">BLOCKED</Badge>
              )}
            </div>
          </div>
        )}

        {/* Info message */}
        <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-secondary">{t("stepEDA.whatIsEDA")}</strong> {t("stepEDA.whatIsEDADesc")}
          </p>
        </div>

        {/* EDA Display */}
        {!hasValidDataset ? (
          <div className="text-center py-12 space-y-3">
            <AlertTriangle className="w-12 h-12 text-destructive/50 mx-auto" />
            <p className="text-muted-foreground font-medium">
              Não é possível executar a análise exploratória.
            </p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              O dataset importado possui problemas estruturais que impedem a análise.
              Volte à etapa anterior e corrija a importação.
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
            disabled={loading || !hasValidDataset}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {!hasValidDataset ? "Corrigir importação" : t("common.next")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepEDA;
