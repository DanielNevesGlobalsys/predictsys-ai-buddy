import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import GlobalControls from "@/components/layout/GlobalControls";
import StepProjectInfo from "./steps/StepProjectInfo";
import StepDataUpload from "./steps/StepDataUpload";
import StepEDA from "./steps/StepEDA";
import PredictiveResolutionPanel from "./steps/PredictiveResolutionPanel";
import StepTargetFeatures from "./steps/StepTargetFeatures";
import StepTraining from "./steps/StepTraining";
import StepDeploy from "./steps/StepDeploy";
import StepScoring from "./steps/StepScoring";
import StepDashboard from "./steps/StepDashboard";
import StepScheduling from "./steps/StepScheduling";
import { trackEvent } from "@/lib/platformTracking";
import { logProjectAuditEvent } from "@/lib/auditLog";
import { useOrganization } from "@/contexts/OrganizationContext";
import PredictSysLogo from "@/components/PredictSysLogo";
import { WizardContextProgress } from "./WizardContextProgress";

export interface ProjectData {
  id?: string;
  name: string;
  description: string;
  business_objective: string;
  problem_type: "classification" | "regression";
  status: string;
  target_column?: string;
  dataset_filename?: string;
  dataset_rows?: number;
  dataset_columns?: number;
  data_source_id?: string;
  sample_rows?: number;
  total_rows?: number;
}

const WizardContainer = () => {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { currentOrganization } = useOrganization();
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [needsRetrain, setNeedsRetrain] = useState(false);
  // SSOT version keys for deterministic rehydration of StepTargetFeatures
  const [ssotVersionKey, setSsotVersionKey] = useState("");
  const [projectData, setProjectData] = useState<ProjectData>({
    name: "",
    description: "",
    business_objective: "",
    problem_type: "classification",
    status: "draft",
  });

  const STEPS = [
    { id: 1, title: t("wizard.steps.info"), description: t("wizard.steps.infoDesc") },
    { id: 2, title: t("wizard.steps.data"), description: t("wizard.steps.dataDesc") },
    { id: 3, title: t("wizard.steps.analysis"), description: t("wizard.steps.analysisDesc") },
    { id: 4, title: "Resolução PRE", description: "Formulação automática do problema preditivo" },
    { id: 5, title: t("wizard.steps.variables"), description: t("wizard.steps.variablesDesc") },
    { id: 6, title: t("wizard.steps.training"), description: t("wizard.steps.trainingDesc") },
    { id: 7, title: "Previsões", description: "Gerar previsões com o modelo" },
    { id: 8, title: t("wizard.steps.deploy"), description: t("wizard.steps.deployDesc") },
    { id: 9, title: t("wizard.steps.dashboard"), description: t("wizard.steps.dashboardDesc") },
    { id: 10, title: "Agendamento", description: "Configurar execuções recorrentes" },
  ];

  // Load SSOT version key for rehydration
  const loadSSOTVersionKey = useCallback(async (id: string) => {
    const { data } = await supabase
      .from("project_settings")
      .select("dataset_version, selection_version")
      .eq("project_id", id)
      .maybeSingle();
    if (data) {
      const d = data as Record<string, any>;
      setSsotVersionKey(`${id}-dv${d.dataset_version || 0}-sv${d.selection_version || 0}`);
    } else {
      setSsotVersionKey(`${id}-dv0-sv0`);
    }
  }, []);

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
      loadSSOTVersionKey(projectId);
    }
  }, [projectId]);

  const loadProject = async (id: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      toast({
        title: t("wizard.loadError"),
        description: error.message,
        variant: "destructive",
      });
      navigate("/dashboard");
    } else if (data) {
      setProjectData({
        id: data.id,
        name: data.name,
        description: data.description || "",
        business_objective: data.business_objective || "",
        problem_type: data.problem_type as "classification" | "regression",
        status: data.status,
        target_column: data.target_column || undefined,
        dataset_filename: data.dataset_filename || undefined,
        dataset_rows: data.dataset_rows || undefined,
        dataset_columns: data.dataset_columns || undefined,
        data_source_id: data.data_source_id || undefined,
        sample_rows: data.sample_rows || undefined,
        total_rows: data.total_rows || undefined,
      });
      // Set step based on status
      if (data.status === "configuring") setCurrentStep(2);
      else if (data.status === "data_uploaded") setCurrentStep(3);
      else if (data.status === "eda_complete") setCurrentStep(4);
      else if (data.status === "training") setCurrentStep(6);
      else if (data.status === "evaluated") setCurrentStep(7);
      else if (data.status === "deployed") setCurrentStep(10);
    }
    setLoading(false);
  };

  const saveProject = async (data: Partial<ProjectData>, nextStep?: number) => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t("common.error"));

      if (projectData.id) {
        // Update existing project
        const updateData: Record<string, any> = {
          name: data.name ?? projectData.name,
          description: data.description ?? projectData.description,
          business_objective: data.business_objective ?? projectData.business_objective,
          problem_type: data.problem_type ?? projectData.problem_type,
          status: data.status ?? projectData.status,
          target_column: data.target_column ?? projectData.target_column,
          dataset_filename: data.dataset_filename ?? projectData.dataset_filename,
          dataset_rows: data.dataset_rows ?? projectData.dataset_rows,
          dataset_columns: data.dataset_columns ?? projectData.dataset_columns,
        };
        
        // Only include new fields if they have values
        if (data.data_source_id !== undefined) updateData.data_source_id = data.data_source_id;
        if (data.sample_rows !== undefined) updateData.sample_rows = data.sample_rows;
        if (data.total_rows !== undefined) updateData.total_rows = data.total_rows;
        
        const { error } = await supabase
          .from("projects")
          .update(updateData)
          .eq("id", projectData.id);

        if (error) throw error;
        setProjectData((prev) => ({ ...prev, ...data }));

        // Generate intent contract on step 1 save (update)
        if (currentStep === 1) {
          generateIntentContractForProject(
            projectData.id,
            data.name ?? projectData.name,
            data.description ?? projectData.description,
            data.business_objective ?? projectData.business_objective
          );
        }
      } else {
        // Create new project with organization_id
        const { data: newProject, error } = await supabase
          .from("projects")
          .insert({
            name: data.name || projectData.name,
            description: data.description || projectData.description,
            business_objective: data.business_objective || projectData.business_objective,
            problem_type: data.problem_type || projectData.problem_type,
            status: "configuring",
            user_id: user.id,
            organization_id: currentOrganization?.id || null,
          })
          .select()
          .single();

        if (error) throw error;
        setProjectData((prev) => ({ ...prev, ...data, id: newProject.id, status: "configuring" }));
        
        // Track project creation event
        trackEvent({
          event_type: "project_created",
          project_id: newProject.id,
          organization_id: newProject.organization_id,
          source: "app",
        });
        
        // Audit log for LGPD compliance
        logProjectAuditEvent(
          newProject.id,
          "project_created",
          "project",
          data.name || projectData.name
        );
        
        // Generate intent contract for new project (fire-and-forget)
        generateIntentContractForProject(
          newProject.id,
          data.name || projectData.name,
          data.description || projectData.description,
          data.business_objective || projectData.business_objective
        );
        
        // Update URL to include project ID
        navigate(`/projeto/${newProject.id}/wizard`, { replace: true });
      }

      if (nextStep) setCurrentStep(nextStep);
      
      toast({
        title: t("wizard.projectSaved"),
        description: t("wizard.projectSavedDesc"),
      });
    } catch (error: any) {
      toast({
        title: t("wizard.saveError"),
        description: error.message,
        variant: "destructive",
      });
    }
    setLoading(false);
  };

  const generateIntentContractForProject = async (
    projectId: string, name: string, description: string, objective: string
  ) => {
    if (!objective?.trim()) return;
    try {
      await supabase.functions.invoke("generate-intent-contract", {
        body: {
          project_id: projectId,
          project_name: name,
          project_description: description,
          declared_objective: objective,
          // Industry will be sent from StepProjectInfo directly; 
          // this fire-and-forget call uses auto-detect as fallback
        },
      });
      console.log("[WizardContainer] Intent contract generated");
    } catch (err) {
      console.warn("[WizardContainer] Intent contract generation failed:", err);
    }
  };

  const handleNext = (data?: Partial<ProjectData>) => {
    if (data) {
      saveProject(data, currentStep + 1);
    } else {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleCancel = () => {
    navigate("/dashboard");
  };

  const handleComplete = async () => {
    // Move to Dashboard step (step 8)
    await saveProject({ status: "deployed" }, 8);
  };

  const handleDashboardNext = () => {
    setCurrentStep(9);
  };
  
  const handleFinalComplete = async () => {
    await saveProject({ status: "deployed" });
    toast({
      title: t("wizard.projectComplete"),
      description: t("wizard.projectCompleteDesc"),
    });
    navigate("/dashboard");
  };

  const handleConfigChange = async () => {
    if (!projectData.id) return;
    
    setNeedsRetrain(true);
    
    // Clear existing models, metrics, and insights from database
    const { data: existingModels } = await supabase
      .from("project_models")
      .select("id")
      .eq("project_id", projectData.id);
    
    if (existingModels && existingModels.length > 0) {
      const modelIds = existingModels.map(m => m.id);
      
      // Delete metrics
      await supabase
        .from("project_model_metrics")
        .delete()
        .in("project_model_id", modelIds);
      
      // Delete feature importances
      await supabase
        .from("project_feature_importances")
        .delete()
        .in("project_model_id", modelIds);
      
      // Delete models
      await supabase
        .from("project_models")
        .delete()
        .eq("project_id", projectData.id);
    }
    
    // Delete training insights
    await supabase
      .from("project_model_insights")
      .delete()
      .eq("project_id", projectData.id)
      .eq("insight_type", "unified_cards");
    
    // Update project status back to eda_complete
    await supabase
      .from("projects")
      .update({ status: "eda_complete" })
      .eq("id", projectData.id);
    
    setProjectData(prev => ({ ...prev, status: "eda_complete" }));
  };

  const handleTrainingComplete = () => {
    setNeedsRetrain(false);
  };

  const renderStep = () => {
    const stepProps = {
      projectData,
      onNext: handleNext,
      onBack: handleBack,
      onCancel: handleCancel,
      loading,
      saveProject,
    };

    switch (currentStep) {
      case 1:
        return <StepProjectInfo {...stepProps} />;
      case 2:
        return <StepDataUpload {...stepProps} />;
      case 3:
        return <StepEDA {...stepProps} />;
      case 4:
        return <StepTargetFeatures key={ssotVersionKey || projectData.id} {...stepProps} onConfigChange={handleConfigChange} onSSOTChanged={() => projectData.id && loadSSOTVersionKey(projectData.id)} />;
      case 5:
        return <StepTraining {...stepProps} needsRetrain={needsRetrain} onTrainingComplete={handleTrainingComplete} onGoToStep={setCurrentStep} />;
      case 6:
        return <StepScoring projectData={projectData} onNext={() => setCurrentStep(7)} onBack={handleBack} loading={loading} saveProject={saveProject} />;
      case 7:
        return <StepDeploy {...stepProps} onComplete={handleComplete} />;
      case 8:
        return <StepDashboard projectData={projectData} onBack={handleBack} loading={loading} saveProject={saveProject} onFinalComplete={handleFinalComplete} onNext={handleDashboardNext} />;
      case 9:
        return <StepScheduling projectData={projectData} onBack={handleBack} loading={loading} saveProject={saveProject} onFinalComplete={handleFinalComplete} />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-hero">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={handleCancel}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <PredictSysLogo size="md" />
            <div>
              <h1 className="text-xl font-bold">
                {projectData.id ? t("wizard.editProject") : t("wizard.newProject")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {projectData.name || t("wizard.configureML")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <GlobalControls />
            <WizardContextProgress projectId={projectData.id} />
          </div>
        </div>
      </header>

      {/* Steps indicator */}
      <div className="border-b border-border/40 bg-card/30 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between max-w-4xl mx-auto">
            {STEPS.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${
                      currentStep === step.id
                        ? "bg-gradient-primary text-primary-foreground shadow-hover"
                        : currentStep > step.id
                        ? "bg-accent text-accent-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {step.id}
                  </div>
                  <span
                    className={`mt-2 text-xs font-medium hidden sm:block ${
                      currentStep === step.id
                        ? "text-primary"
                        : currentStep > step.id
                        ? "text-accent"
                        : "text-muted-foreground"
                    }`}
                  >
                    {step.title}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div
                    className={`w-8 sm:w-16 h-1 mx-2 rounded-full ${
                      currentStep > step.id ? "bg-accent" : "bg-muted"
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Step content */}
      <main className="container mx-auto px-4 py-8">
        {renderStep()}
      </main>
    </div>
  );
};

export default WizardContainer;
