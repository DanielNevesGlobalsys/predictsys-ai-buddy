import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LayoutDashboard, ArrowLeft } from "lucide-react";
import type { ProjectData } from "../WizardContainer";
import DashboardContent from "@/components/dashboard/DashboardContent";

interface StepDashboardProps {
  projectData: ProjectData;
  onBack: () => void;
  loading: boolean;
}

const StepDashboard = ({ projectData, onBack, loading }: StepDashboardProps) => {
  const { t } = useTranslation();

  if (!projectData.id) {
    return (
      <Card className="bg-gradient-card shadow-card p-8 text-center">
        <LayoutDashboard className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="font-semibold text-lg mb-2">
          {t("dashboard.title")}
        </h3>
        <p className="text-muted-foreground">
          {t("modelDashboard.completeSteps")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <LayoutDashboard className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            {t("modelDashboard.title")}
          </h2>
          <p className="text-muted-foreground">
            {t("modelDashboard.subtitle")}
          </p>
        </div>

        <DashboardContent 
          projectId={projectData.id}
          problemType={projectData.problem_type}
          targetColumn={projectData.target_column}
          projectName={projectData.name}
        />

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("common.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDashboard;
