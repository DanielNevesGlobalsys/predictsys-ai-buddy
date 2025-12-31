import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNavigate } from "react-router-dom";
import { Brain, Plus, FolderKanban, Loader2, BookOpen, Bot } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import ProjectCardMenu from "@/components/project/ProjectCardMenu";
import Header from "@/components/layout/Header";

interface Project {
  id: string;
  name: string;
  problem_type: string;
  status: string;
  created_at: string;
}

const Dashboard = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

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

  const getProblemTypeLabel = (type: string) => {
    return t(`project.${type}`, type);
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, problem_type, status, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      toast({
        title: t("dashboard.errorLoading"),
        description: error.message,
        variant: "destructive",
      });
    } else {
      setProjects(data || []);
    }
    setLoading(false);
  };

  const handleCreateProject = () => {
    navigate("/projeto/novo/wizard");
  };

  const handleOpenProject = (projectId: string) => {
    navigate(`/projeto/${projectId}`);
  };

  const handleProjectDeleted = (projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
  };

  const getDateLocale = () => {
    const lang = i18n.language;
    if (lang === "en") return "en-US";
    if (lang === "es") return "es-ES";
    return "pt-BR";
  };

  return (
    <div className="min-h-screen bg-gradient-hero">
      <Header />

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-display font-bold mb-2">{t("dashboard.title")}</h1>
            <p className="text-muted-foreground text-lg">
              {t("dashboard.subtitle")}
            </p>
          </div>
          <Button 
            size="lg"
            className="bg-gradient-primary hover:shadow-hover transition-all"
            onClick={handleCreateProject}
          >
            <Plus className="w-5 h-5 mr-2" />
            {t("dashboard.newProject")}
          </Button>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {/* Projects Grid or Empty State */}
        {!loading && projects.length === 0 ? (
          <Card className="bg-gradient-card shadow-card p-12 text-center">
            <div className="max-w-md mx-auto space-y-6">
              <div className="w-20 h-20 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto">
                <FolderKanban className="w-10 h-10 text-primary-foreground" />
              </div>
              <div>
                <h3 className="text-2xl font-display font-semibold mb-2">
                  {t("dashboard.noProjects")}
                </h3>
                <p className="text-muted-foreground text-lg">
                  {t("dashboard.noProjectsDesc")}
                </p>
              </div>
              <Button 
                size="lg"
                className="bg-gradient-primary hover:shadow-hover transition-all"
                onClick={handleCreateProject}
              >
                <Plus className="w-5 h-5 mr-2" />
                {t("dashboard.createFirst")}
              </Button>
            </div>
          </Card>
        ) : (
          !loading && (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {projects.map((project) => {
                const statusInfo = getStatusInfo(project.status);
                return (
                  <Card
                    key={project.id}
                    className="bg-gradient-card shadow-card p-6 hover:shadow-hover transition-all cursor-pointer"
                    onClick={() => handleOpenProject(project.id)}
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div className="w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center">
                        <Brain className="w-6 h-6 text-primary-foreground" />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-2 py-1 rounded-full ${statusInfo.color}`}>
                          {statusInfo.label}
                        </span>
                        <ProjectCardMenu
                          projectId={project.id}
                          projectName={project.name}
                          onDeleted={() => handleProjectDeleted(project.id)}
                        />
                      </div>
                    </div>
                    <h3 className="font-semibold text-lg mb-1 line-clamp-1">
                      {project.name}
                    </h3>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>{getProblemTypeLabel(project.problem_type)}</span>
                      <span>•</span>
                      <span>
                        {new Date(project.created_at).toLocaleDateString(getDateLocale())}
                      </span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )
        )}

        {/* Quick Actions */}
        <div className="mt-12 grid md:grid-cols-3 gap-6">
          <Card 
            className="bg-gradient-card shadow-card p-6 hover:shadow-hover transition-all cursor-pointer"
            onClick={() => navigate("/guia-rapido")}
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <Brain className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">{t("dashboard.quickGuide")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("dashboard.quickGuideDesc")}
                </p>
              </div>
            </div>
          </Card>

          <Card 
            className="bg-gradient-card shadow-card p-6 hover:shadow-hover transition-all cursor-pointer"
            onClick={() => navigate("/chatbot")}
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-secondary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <Bot className="w-6 h-6 text-secondary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">{t("dashboard.chatbot")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("dashboard.chatbotDesc")}
                </p>
              </div>
            </div>
          </Card>

          <Card 
            className="bg-gradient-card shadow-card p-6 hover:shadow-hover transition-all cursor-pointer"
            onClick={() => navigate("/documentacao")}
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <BookOpen className="w-6 h-6 text-accent" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">{t("dashboard.documentation")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("dashboard.documentationDesc")}
                </p>
              </div>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
