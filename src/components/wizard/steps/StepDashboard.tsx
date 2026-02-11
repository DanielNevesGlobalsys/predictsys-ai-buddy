import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LayoutDashboard, ArrowLeft, CheckCircle, Loader2, AlertTriangle, Play } from "lucide-react";
import type { ProjectData } from "../WizardContainer";
import { BusinessDashboard } from "@/components/business-dashboard";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface StepDashboardProps {
  projectData: ProjectData;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
  onFinalComplete: () => Promise<void>;
}

const StepDashboard = ({ projectData, onBack, loading, saveProject, onFinalComplete }: StepDashboardProps) => {
  const { t } = useTranslation();
  const [hasProductionModel, setHasProductionModel] = useState(false);
  const [hasPredictions, setHasPredictions] = useState<boolean | null>(null); // null = loading
  const [predictionsCount, setPredictionsCount] = useState(0);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    if (projectData.id) {
      checkProductionModel();
      checkPredictions();
    }
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

  const checkPredictions = async () => {
    if (!projectData.id) return;
    const { count } = await supabase
      .from("predictions")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectData.id)
      .eq("is_latest", true);
    const c = count ?? 0;
    setPredictionsCount(c);
    setHasPredictions(c > 0);
  };

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

  // Loading predictions check
  if (hasPredictions === null) {
    return (
      <Card className="bg-gradient-card shadow-card p-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Card>
    );
  }

  // No predictions — explicit block
  if (!hasPredictions) {
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
              ⚠️ Não foram encontradas previsões válidas para este projeto. Execute o Scoring na etapa de Deploy para gerar previsões e habilitar o Dashboard.
            </p>
            <Button variant="outline" onClick={onBack} className="mt-2">
              <Play className="w-4 h-4 mr-2" />
              Voltar ao Deploy e gerar previsões
            </Button>
          </div>

          <div className="flex justify-between pt-6 border-t border-border">
            <Button variant="outline" onClick={onBack} disabled={loading || completing}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t("common.back")}
            </Button>
          </div>
        </div>
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
          <h2 className="text-2xl font-display font-bold mb-2">{t("modelDashboard.title")}</h2>
          <p className="text-muted-foreground">{t("modelDashboard.subtitle")}</p>
        </div>

        <BusinessDashboard projectId={projectData.id} />

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading || completing}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("common.back")}
          </Button>
          <Button
            onClick={handleCompleteProject}
            disabled={loading || completing || !hasProductionModel}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            {completing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t("common.loading")}
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 mr-2" />
                {t("stepDashboard.completeProject")}
              </>
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDashboard;
