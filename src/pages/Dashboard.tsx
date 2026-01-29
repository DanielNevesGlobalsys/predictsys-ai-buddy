import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  PlusCircle,
  Calendar,
  Database,
  ArrowRight,
  Loader2,
  BookOpen,
} from "lucide-react";
import Header from "@/components/layout/Header";
import ProjectCardMenu from "@/components/project/ProjectCardMenu";
import PredictSysLogo from "@/components/PredictSysLogo";

interface Project {
  id: string;
  name: string;
  description: string | null;
  problem_type: string;
  status: string;
  dataset_rows: number | null;
  total_rows: number | null;
  created_at: string;
  updated_at: string;
}

const Dashboard = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const getDateLocale = () => {
    const lang = i18n.language;
    if (lang === "en") return "en-US";
    if (lang === "es") return "es-ES";
    return "pt-BR";
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive",
      });
    } else {
      setProjects(data || []);
    }
    setLoading(false);
  };

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

  const handleProjectDeleted = (projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
  };

  return (
    <div className="min-h-screen bg-gradient-hero">
      <Header />

      <main className="container mx-auto px-4 py-8">
        {/* Hero Section */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-display font-bold mb-2">
              {t("dashboard.myProjects")}
            </h1>
            <p className="text-muted-foreground">
              {t("dashboard.manageProjects")}
            </p>
          </div>
          <Button
            onClick={() => navigate("/projeto/novo/wizard")}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            <PlusCircle className="w-4 h-4 mr-2" />
            {t("dashboard.newProject")}
          </Button>
        </div>

        {/* Projects Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : projects.length === 0 ? (
          <Card className="bg-gradient-card shadow-card p-12 text-center">
            <div className="mx-auto mb-4">
              <PredictSysLogo size="xl" className="mx-auto opacity-50" />
            </div>
            <h3 className="text-xl font-semibold mb-2">{t("dashboard.noProjects")}</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              {t("dashboard.noProjectsDesc")}
            </p>
            <Button
              onClick={() => navigate("/projeto/novo/wizard")}
              className="bg-gradient-primary hover:shadow-hover transition-all"
            >
              <PlusCircle className="w-4 h-4 mr-2" />
              {t("dashboard.createFirst")}
            </Button>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => {
              const statusInfo = getStatusInfo(project.status);
              return (
                <Card
                  key={project.id}
                  className="bg-gradient-card shadow-card hover:shadow-hover transition-all duration-300 overflow-hidden group cursor-pointer"
                  onClick={() => navigate(`/projeto/${project.id}`)}
                >
                  <div className="p-6">
                    <div className="flex items-start justify-between mb-4">
                      <PredictSysLogo size="sm" />
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
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

                    <h3 className="font-semibold text-lg mb-2 line-clamp-1">
                      {project.name}
                    </h3>
                    {project.description && (
                      <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                        {project.description}
                      </p>
                    )}

                    <div className="flex flex-wrap gap-2 mb-4">
                      <span className="text-xs px-2 py-1 rounded-full bg-secondary/10 text-secondary">
                        {t(`project.${project.problem_type}`)}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      {(project.total_rows || project.dataset_rows) && (
                        <span className="flex items-center gap-1">
                          <Database className="w-3 h-3" />
                          {(project.total_rows || project.dataset_rows)?.toLocaleString(getDateLocale())} {t("common.rows")}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(project.updated_at).toLocaleDateString(getDateLocale())}
                      </span>
                    </div>
                  </div>

                  <div className="px-6 py-3 bg-muted/30 border-t border-border/40 flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {t("dashboard.viewProject")}
                    </span>
                    <ArrowRight className="w-4 h-4 text-primary group-hover:translate-x-1 transition-transform" />
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {/* Quick Actions */}
        <div className="mt-12 grid md:grid-cols-3 gap-6">
          <Card 
            className="bg-gradient-card shadow-card p-6 hover:shadow-hover transition-all cursor-pointer"
            onClick={() => navigate("/guia-rapido")}
          >
            <div className="flex items-start gap-4">
              <PredictSysLogo size="sm" className="flex-shrink-0" />
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
              <img 
                src="/images/assistente-globalsys.png" 
                alt="Assistente virtual Globalsys"
                className="w-12 h-12 rounded-full object-cover flex-shrink-0"
              />
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
