import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useTranslateContent } from "@/hooks/useTranslateContent";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Brain,
  ChevronLeft,
  Settings,
  BarChart3,
  Database,
  Cpu,
  Rocket,
  MessageSquare,
  Edit,
  Loader2,
  Languages,
} from "lucide-react";
import EDADisplay from "@/components/eda/EDADisplay";
import ModelsTab from "@/components/project/ModelsTab";
import APIDeployTab from "@/components/project/APIDeployTab";
import ChatTab from "@/components/project/ChatTab";
import SettingsTab from "@/components/project/SettingsTab";
import Header from "@/components/layout/Header";

interface Project {
  id: string;
  name: string;
  description: string | null;
  business_objective: string | null;
  problem_type: string;
  status: string;
  target_column: string | null;
  dataset_filename: string | null;
  dataset_rows: number | null;
  dataset_columns: number | null;
  created_at: string;
  updated_at: string;
}

const ProjectDetails = () => {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatKey, setChatKey] = useState(0);

  const getStatusInfo = (status: string) => {
    const colors: Record<string, string> = {
      draft: "bg-muted text-muted-foreground",
      configuring: "bg-secondary/20 text-secondary",
      data_uploaded: "bg-primary/20 text-primary",
      eda_complete: "bg-accent/20 text-accent",
      training: "bg-destructive/20 text-destructive",
      evaluated: "bg-accent/20 text-accent",
      deployed: "bg-accent text-accent-foreground",
    };
    return {
      label: t(`project.status.${status}`, status),
      color: colors[status] || colors.draft,
    };
  };

  const getDateLocale = () => {
    const lang = i18n.language;
    if (lang === "en") return "en-US";
    if (lang === "es") return "es-ES";
    return "pt-BR";
  };

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
  }, [projectId]);

  const loadProject = async (id: string) => {
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive",
      });
      navigate("/dashboard");
    } else {
      setProject(data);
    }
    setLoading(false);
  };

  const handleChatCleared = useCallback(() => {
    setChatKey((prev) => prev + 1);
  }, []);

  // Translation of project content
  const contentToTranslate = useMemo(() => ({
    name: project?.name || "",
    description: project?.description || "",
    business_objective: project?.business_objective || "",
  }), [project?.name, project?.description, project?.business_objective]);

  const { translations, isTranslating, originalLanguage } = useTranslateContent(
    contentToTranslate,
    !!project
  );

  const getLanguageName = (lang: string | null) => {
    if (!lang) return "";
    const names: Record<string, Record<string, string>> = {
      pt: { pt: "Português", en: "Portuguese", es: "Portugués" },
      en: { pt: "Inglês", en: "English", es: "Inglés" },
      es: { pt: "Espanhol", en: "Spanish", es: "Español" },
    };
    return names[lang]?.[i18n.language.split("-")[0]] || lang;
  };

  const currentLang = i18n.language.split("-")[0];
  const needsTranslation = originalLanguage && originalLanguage !== currentLang;

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-hero flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!project) {
    return null;
  }

  const statusInfo = getStatusInfo(project.status);

  return (
    <div className="min-h-screen bg-gradient-hero">
      <Header />

      {/* Sub Header */}
      <div className="border-b border-border/40 bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <div className="w-10 h-10 bg-gradient-primary rounded-xl flex items-center justify-center">
              <Brain className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold">{project.name}</h1>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full ${statusInfo.color}`}>
                  {statusInfo.label}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`project.${project.problem_type}`)}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => navigate(`/projeto/${project.id}/wizard`)}
            >
              <Edit className="w-4 h-4 mr-2" />
              {t("common.edit")}
            </Button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="bg-card/50 p-1">
            <TabsTrigger value="overview" className="gap-2">
              <BarChart3 className="w-4 h-4" />
              {t("project.tabs.overview")}
            </TabsTrigger>
            <TabsTrigger value="data" className="gap-2">
              <Database className="w-4 h-4" />
              {t("project.tabs.data")}
            </TabsTrigger>
            <TabsTrigger value="models" className="gap-2">
              <Cpu className="w-4 h-4" />
              {t("project.tabs.models")}
            </TabsTrigger>
            <TabsTrigger value="deploy" className="gap-2">
              <Rocket className="w-4 h-4" />
              {t("project.tabs.deploy")}
            </TabsTrigger>
            <TabsTrigger value="chat" className="gap-2">
              <MessageSquare className="w-4 h-4" />
              {t("project.tabs.chat")}
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-2">
              <Settings className="w-4 h-4" />
              {t("project.tabs.settings")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {/* Translation indicator */}
            {needsTranslation && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg">
                <Languages className="w-4 h-4" />
                {isTranslating ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {t("projectDetails.translating")}
                  </span>
                ) : (
                  <span>{t("projectDetails.translatedFrom", { language: getLanguageName(originalLanguage) })}</span>
                )}
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-6">
              <Card className="bg-gradient-card shadow-card p-6">
                <h3 className="font-semibold mb-4">{t("projectDetails.projectInfo")}</h3>
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground">{t("projectDetails.name")}</p>
                    <p className="font-medium">{translations.name || project.name}</p>
                  </div>
                  {(translations.description || project.description) && (
                    <div>
                      <p className="text-sm text-muted-foreground">{t("projectDetails.description")}</p>
                      <p>{translations.description || project.description}</p>
                    </div>
                  )}
                  {(translations.business_objective || project.business_objective) && (
                    <div>
                      <p className="text-sm text-muted-foreground">{t("projectDetails.businessObjective")}</p>
                      <p>{translations.business_objective || project.business_objective}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">{t("projectDetails.problemType")}</p>
                    <p className="font-medium">
                      {t(`project.${project.problem_type}`)}
                    </p>
                  </div>
                </div>
              </Card>

              <Card className="bg-gradient-card shadow-card p-6">
                <h3 className="font-semibold mb-4">{t("projectDetails.projectStatus")}</h3>
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground">{t("projectDetails.currentStatus")}</p>
                    <span className={`inline-block mt-1 text-sm px-3 py-1 rounded-full ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                  </div>
                  {project.target_column && (
                    <div>
                      <p className="text-sm text-muted-foreground">{t("projectDetails.targetVariable")}</p>
                      <p className="font-medium">{project.target_column}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">{t("projectDetails.createdAt")}</p>
                    <p>{new Date(project.created_at).toLocaleDateString(getDateLocale())}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t("projectDetails.updatedAt")}</p>
                    <p>{new Date(project.updated_at).toLocaleDateString(getDateLocale())}</p>
                  </div>
                </div>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="data" className="space-y-6">
            {/* Dataset info */}
            {project.dataset_filename && (
              <Card className="bg-gradient-card shadow-card p-6">
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <Database className="w-5 h-5 text-primary" />
                  {t("projectDetails.datasetInfo")}
                </h3>
                <div className="grid sm:grid-cols-3 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">{t("projectDetails.file")}</p>
                    <p className="font-medium truncate">{project.dataset_filename.split("/").pop()}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t("projectDetails.rows")}</p>
                    <p className="font-medium">{project.dataset_rows?.toLocaleString(getDateLocale()) || "-"}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t("projectDetails.columns")}</p>
                    <p className="font-medium">{project.dataset_columns || "-"}</p>
                  </div>
                </div>
              </Card>
            )}

            {/* EDA Display */}
            {project.dataset_filename ? (
              <EDADisplay projectId={project.id} projectName={project.name} datasetFilename={project.dataset_filename} />
            ) : (
              <Card className="bg-gradient-card shadow-card p-8 text-center">
                <Database className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="font-semibold text-lg mb-2">{t("projectDetails.noData")}</h3>
                <p className="text-muted-foreground mb-4">
                  {t("projectDetails.noDataDesc")}
                </p>
                <Button onClick={() => navigate(`/projeto/${project.id}/wizard`)}>
                  {t("projectDetails.goToWizard")}
                </Button>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="models">
            <ModelsTab 
              projectId={project.id} 
              problemType={project.problem_type}
              datasetRows={project.dataset_rows || undefined}
              targetColumn={project.target_column || undefined}
            />
          </TabsContent>

          <TabsContent value="deploy">
            <APIDeployTab 
              projectId={project.id} 
              problemType={project.problem_type}
              targetColumn={project.target_column}
            />
          </TabsContent>

          <TabsContent value="chat">
            <ChatTab key={chatKey} projectId={project.id} projectName={project.name} />
          </TabsContent>

          <TabsContent value="settings">
            <SettingsTab
              projectId={project.id}
              projectName={project.name}
              onChatCleared={handleChatCleared}
            />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default ProjectDetails;
