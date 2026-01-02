import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, Info } from "lucide-react";
import DataSourceTabs from "@/components/data-ingestion/DataSourceTabs";
import type { ProjectData } from "../WizardContainer";

interface StepDataUploadProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

const StepDataUpload = ({ projectData, onNext, onBack, loading, saveProject }: StepDataUploadProps) => {
  const { t } = useTranslation();
  const [isDataReady, setIsDataReady] = useState(false);

  useEffect(() => {
    // Check if data is already uploaded
    if (projectData.dataset_filename || projectData.data_source_id) {
      setIsDataReady(true);
    }
  }, [projectData.dataset_filename, projectData.data_source_id]);

  const handleDataReady = () => {
    setIsDataReady(true);
  };

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
