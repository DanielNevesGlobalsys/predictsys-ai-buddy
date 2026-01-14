import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";
import DataSourceTabs from "@/components/data-ingestion/DataSourceTabs";
import { supabase } from "@/integrations/supabase/client";
import type { ProjectData } from "../WizardContainer";

interface StepDataUploadProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

const POLLING_INTERVAL = 3000; // 3 seconds

const StepDataUpload = ({ projectData, onNext, onBack, loading, saveProject }: StepDataUploadProps) => {
  const { t } = useTranslation();
  const [isDataReady, setIsDataReady] = useState(false);

  // Check if data is ready based on project status and dataset
  const checkDataReady = useCallback(async () => {
    if (!projectData.id) return false;

    // First check local projectData
    if (projectData.dataset_filename || projectData.data_source_id) {
      return true;
    }

    // Then check database for latest status
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

  // Initial check
  useEffect(() => {
    const initialCheck = async () => {
      const ready = await checkDataReady();
      setIsDataReady(ready);
    };
    initialCheck();
  }, [checkDataReady]);

  // Poll for import completion if there are active jobs
  useEffect(() => {
    if (!projectData.id || isDataReady) return;

    let isMounted = true;
    let intervalId: NodeJS.Timeout | null = null;

    const pollForCompletion = async () => {
      if (!isMounted) return;

      // Check for active import jobs
      const { data: activeJobs } = await supabase
        .from("import_jobs")
        .select("id, status")
        .eq("project_id", projectData.id)
        .in("status", ["pending", "processing"]);

      if (activeJobs && activeJobs.length > 0) {
        // Still have active jobs, continue polling
        return;
      }

      // Check for completed jobs
      const { data: completedJobs } = await supabase
        .from("import_jobs")
        .select("id, status, rows_processed")
        .eq("project_id", projectData.id)
        .eq("status", "completed")
        .order("finished_at", { ascending: false })
        .limit(1);

      if (completedJobs && completedJobs.length > 0) {
        // Job completed, check if project has data
        const ready = await checkDataReady();
        if (ready && isMounted) {
          setIsDataReady(true);
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      }
    };

    // Start polling
    intervalId = setInterval(pollForCompletion, POLLING_INTERVAL);

    // Initial poll
    pollForCompletion();

    return () => {
      isMounted = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [projectData.id, isDataReady, checkDataReady]);

  const handleDataReady = useCallback(() => {
    setIsDataReady(true);
  }, []);

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

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            {t("common.back")}
          </Button>
          <Button
            onClick={() => onNext()}
            disabled={loading || !isDataReady}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {isDataReady ? t("common.next") : t("dataIngestion.uploadToContinue")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDataUpload;
