import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, ShieldAlert } from "lucide-react";
import DataSourceTabs from "@/components/data-ingestion/DataSourceTabs";
import { ImportManifestPanel } from "@/components/import";
import { supabase } from "@/integrations/supabase/client";
import type { ProjectData } from "../WizardContainer";

interface StepDataUploadProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

const POLLING_INTERVAL = 3000;

const StepDataUpload = ({ projectData, onNext, onBack, loading, saveProject }: StepDataUploadProps) => {
  const { t } = useTranslation();
  const [isDataReady, setIsDataReady] = useState(false);
  const [manifestStatus, setManifestStatus] = useState<string | null>(null);
  const [manifestReason, setManifestReason] = useState<string | null>(null);
  const [showManifest, setShowManifest] = useState(false);

  const isBlocked = manifestStatus === "blocked" || manifestStatus === "fail";

  // Check manifest status
  const checkManifestStatus = useCallback(async () => {
    if (!projectData.id) return;
    const { data } = await supabase
      .from("import_manifests")
      .select("status, status_reason")
      .eq("project_id", projectData.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (data) {
      setManifestStatus(data.status);
      setManifestReason(data.status_reason);
      setShowManifest(true);
    }
  }, [projectData.id]);

  // Check if data is ready based on project status and dataset
  const checkDataReady = useCallback(async () => {
    if (!projectData.id) return false;
    if (projectData.dataset_filename || projectData.data_source_id) return true;
    const { data: project } = await supabase
      .from("projects")
      .select("dataset_filename, data_source_id, status, total_rows, dataset_columns")
      .eq("id", projectData.id)
      .single();
    if (project) {
      const hasData = !!(project.dataset_filename || project.data_source_id);
      const isUploaded = project.status === "data_uploaded" || 
                         project.status === "eda_complete" || 
                         project.status === "training" ||
                         project.status === "deployed";
      return hasData || isUploaded;
    }
    return false;
  }, [projectData.id, projectData.dataset_filename, projectData.data_source_id]);

  useEffect(() => {
    const initialCheck = async () => {
      const ready = await checkDataReady();
      setIsDataReady(ready);
      if (ready) await checkManifestStatus();
    };
    initialCheck();
  }, [checkDataReady, checkManifestStatus]);

  // Poll for import completion
  useEffect(() => {
    if (!projectData.id || isDataReady) return;
    let isMounted = true;
    let intervalId: NodeJS.Timeout | null = null;

    const pollForCompletion = async () => {
      if (!isMounted) return;
      const { data: activeJobs } = await supabase
        .from("import_jobs")
        .select("id, status")
        .eq("project_id", projectData.id)
        .in("status", ["pending", "processing"]);
      if (activeJobs && activeJobs.length > 0) return;

      const { data: completedJobs } = await supabase
        .from("import_jobs")
        .select("id, status, rows_processed")
        .eq("project_id", projectData.id)
        .eq("status", "completed")
        .order("finished_at", { ascending: false })
        .limit(1);

      if (completedJobs && completedJobs.length > 0) {
        const ready = await checkDataReady();
        if (ready && isMounted) {
          setIsDataReady(true);
          await checkManifestStatus();
          if (intervalId) { clearInterval(intervalId); intervalId = null; }
        }
      }
    };

    intervalId = setInterval(pollForCompletion, POLLING_INTERVAL);
    pollForCompletion();
    return () => { isMounted = false; if (intervalId) clearInterval(intervalId); };
  }, [projectData.id, isDataReady, checkDataReady, checkManifestStatus]);

  const handleDataReady = useCallback(async () => {
    setIsDataReady(true);
    // Small delay to let manifest be created
    setTimeout(() => checkManifestStatus(), 2000);
  }, [checkManifestStatus]);

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Upload className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            {t("dataIngestion.title")}
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            {t("dataIngestion.subtitle")}
          </p>
        </div>

        {/* Data Source Tabs */}
        <DataSourceTabs 
          projectData={projectData}
          saveProject={saveProject}
          onDataReady={handleDataReady}
        />

        {/* Import Manifest Panel - shown after import */}
        {showManifest && projectData.id && (
          <ImportManifestPanel projectId={projectData.id} />
        )}

        {/* Blocked alert */}
        {isBlocked && manifestReason && (
          <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
            <ShieldAlert className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-destructive text-sm">Dataset bloqueado para modelagem</p>
              <p className="text-sm text-destructive/80 mt-1">{manifestReason}</p>
              <p className="text-xs text-muted-foreground mt-2">
                Corrija os problemas acima e reimporte os dados para continuar.
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            {t("common.back")}
          </Button>
          <Button
            onClick={() => onNext()}
            disabled={loading || !isDataReady || isBlocked}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {isBlocked
              ? "Corrigir importação"
              : isDataReady
              ? t("common.next")
              : t("dataIngestion.uploadToContinue")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDataUpload;
