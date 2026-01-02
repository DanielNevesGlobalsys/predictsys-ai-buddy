import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Brain, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import GlobalControls from "@/components/layout/GlobalControls";
import StepProjectInfo from "./steps/StepProjectInfo";
import StepDataUpload from "./steps/StepDataUpload";
import StepEDA from "./steps/StepEDA";
import StepTargetFeatures from "./steps/StepTargetFeatures";
import StepTraining from "./steps/StepTraining";
import StepDeploy from "./steps/StepDeploy";
import StepDashboard from "./steps/StepDashboard";

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
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
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
    { id: 4, title: t("wizard.steps.variables"), description: t("wizard.steps.variablesDesc") },
    { id: 5, title: t("wizard.steps.training"), description: t("wizard.steps.trainingDesc") },
    { id: 6, title: t("wizard.steps.deploy"), description: t("wizard.steps.deployDesc") },
    { id: 7, title: t("wizard.steps.dashboard"), description: t("wizard.steps.dashboardDesc") },
  ];

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
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
      else if (data.status === "training") setCurrentStep(5);
      else if (data.status === "evaluated") setCurrentStep(6);
      else if (data.status === "deployed") setCurrentStep(7);
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
      } else {
        // Create new project
        const { data: newProject, error } = await supabase
          .from("projects")
          .insert({
            name: data.name || projectData.name,
            description: data.description || projectData.description,
            business_objective: data.business_objective || projectData.business_objective,
            problem_type: data.problem_type || projectData.problem_type,
            status: "configuring",
            user_id: user.id,
          })
          .select()
          .single();

        if (error) throw error;
        setProjectData((prev) => ({ ...prev, ...data, id: newProject.id, status: "configuring" }));
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
    await saveProject({ status: "evaluated" });
    toast({
      title: t("wizard.projectComplete"),
      description: t("wizard.projectCompleteDesc"),
    });
    navigate("/dashboard");
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
        return <StepTargetFeatures {...stepProps} />;
      case 5:
        return <StepTraining {...stepProps} />;
      case 6:
        return <StepDeploy {...stepProps} onComplete={handleComplete} />;
      case 7:
        return <StepDashboard projectData={projectData} onBack={handleBack} loading={loading} saveProject={saveProject} />;
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
            <div className="w-10 h-10 bg-gradient-primary rounded-xl flex items-center justify-center">
              <Brain className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold">
                {projectData.id ? t("wizard.editProject") : t("wizard.newProject")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {projectData.name || t("wizard.configureML")}
              </p>
            </div>
          </div>
          <GlobalControls />
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
