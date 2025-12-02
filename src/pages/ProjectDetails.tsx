import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
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
} from "lucide-react";

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

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: "Rascunho", color: "bg-muted text-muted-foreground" },
  configuring: { label: "Configurando", color: "bg-secondary/20 text-secondary" },
  data_uploaded: { label: "Dados enviados", color: "bg-primary/20 text-primary" },
  eda_complete: { label: "EDA completa", color: "bg-accent/20 text-accent" },
  training: { label: "Treinando", color: "bg-destructive/20 text-destructive" },
  evaluated: { label: "Avaliado", color: "bg-accent/20 text-accent" },
  deployed: { label: "Em produção", color: "bg-accent text-accent-foreground" },
};

const ProjectDetails = () => {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const { toast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

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
        title: "Erro ao carregar projeto",
        description: error.message,
        variant: "destructive",
      });
      navigate("/dashboard");
    } else {
      setProject(data);
    }
    setLoading(false);
  };

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

  const statusInfo = STATUS_LABELS[project.status] || STATUS_LABELS.draft;

  return (
    <div className="min-h-screen bg-gradient-hero">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
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
                  {project.problem_type === "classification" ? "Classificação" : "Regressão"}
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
              Editar
            </Button>
            <Button variant="ghost" size="icon">
              <Settings className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="bg-card/50 p-1">
            <TabsTrigger value="overview" className="gap-2">
              <BarChart3 className="w-4 h-4" />
              Visão Geral
            </TabsTrigger>
            <TabsTrigger value="data" className="gap-2">
              <Database className="w-4 h-4" />
              Dados & EDA
            </TabsTrigger>
            <TabsTrigger value="models" className="gap-2">
              <Cpu className="w-4 h-4" />
              Modelos
            </TabsTrigger>
            <TabsTrigger value="deploy" className="gap-2">
              <Rocket className="w-4 h-4" />
              API & Deploy
            </TabsTrigger>
            <TabsTrigger value="chat" className="gap-2">
              <MessageSquare className="w-4 h-4" />
              Chatbot
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid md:grid-cols-2 gap-6">
              <Card className="bg-gradient-card shadow-card p-6">
                <h3 className="font-semibold mb-4">Informações do Projeto</h3>
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Nome</p>
                    <p className="font-medium">{project.name}</p>
                  </div>
                  {project.description && (
                    <div>
                      <p className="text-sm text-muted-foreground">Descrição</p>
                      <p>{project.description}</p>
                    </div>
                  )}
                  {project.business_objective && (
                    <div>
                      <p className="text-sm text-muted-foreground">Objetivo de Negócio</p>
                      <p>{project.business_objective}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">Tipo de Problema</p>
                    <p className="font-medium">
                      {project.problem_type === "classification" ? "Classificação" : "Regressão"}
                    </p>
                  </div>
                </div>
              </Card>

              <Card className="bg-gradient-card shadow-card p-6">
                <h3 className="font-semibold mb-4">Status do Projeto</h3>
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Status Atual</p>
                    <span className={`inline-block mt-1 text-sm px-3 py-1 rounded-full ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                  </div>
                  {project.target_column && (
                    <div>
                      <p className="text-sm text-muted-foreground">Variável Alvo</p>
                      <p className="font-medium">{project.target_column}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">Criado em</p>
                    <p>{new Date(project.created_at).toLocaleDateString("pt-BR")}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Última atualização</p>
                    <p>{new Date(project.updated_at).toLocaleDateString("pt-BR")}</p>
                  </div>
                </div>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="data">
            <Card className="bg-gradient-card shadow-card p-8 text-center">
              <Database className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-semibold text-lg mb-2">Dados e Análise Exploratória</h3>
              <p className="text-muted-foreground">
                Esta seção mostrará os dados carregados e análises exploratórias.
              </p>
            </Card>
          </TabsContent>

          <TabsContent value="models">
            <Card className="bg-gradient-card shadow-card p-8 text-center">
              <Cpu className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-semibold text-lg mb-2">Modelos Treinados</h3>
              <p className="text-muted-foreground">
                Esta seção mostrará os modelos treinados e suas métricas.
              </p>
            </Card>
          </TabsContent>

          <TabsContent value="deploy">
            <Card className="bg-gradient-card shadow-card p-8 text-center">
              <Rocket className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-semibold text-lg mb-2">API e Deploy</h3>
              <p className="text-muted-foreground">
                Esta seção mostrará informações da API e opções de deploy.
              </p>
            </Card>
          </TabsContent>

          <TabsContent value="chat">
            <Card className="bg-gradient-card shadow-card p-8 text-center">
              <MessageSquare className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-semibold text-lg mb-2">Chatbot IA</h3>
              <p className="text-muted-foreground">
                Converse sobre este projeto e tire dúvidas sobre os dados e modelos.
              </p>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default ProjectDetails;
