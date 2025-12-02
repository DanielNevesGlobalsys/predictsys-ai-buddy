import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNavigate } from "react-router-dom";
import { Brain, Plus, FolderKanban, LogOut, MessageSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

const Dashboard = () => {
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast({
        title: "Erro ao sair",
        description: error.message,
        variant: "destructive",
      });
    } else {
      navigate("/auth");
    }
  };

  // Mock data for projects - will be replaced with real data later
  const projects = [];

  return (
    <div className="min-h-screen bg-gradient-hero">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-primary rounded-xl flex items-center justify-center">
              <Brain className="w-6 h-6 text-primary-foreground" />
            </div>
            <h1 className="text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent">
              PredictSys AI
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon">
              <MessageSquare className="w-5 h-5" />
            </Button>
            <Button variant="ghost" onClick={handleLogout}>
              <LogOut className="w-4 h-4 mr-2" />
              Sair
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-display font-bold mb-2">Meus Projetos</h1>
            <p className="text-muted-foreground text-lg">
              Gerencie seus projetos de machine learning
            </p>
          </div>
          <Button 
            size="lg"
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            <Plus className="w-5 h-5 mr-2" />
            Novo Projeto
          </Button>
        </div>

        {/* Projects Grid or Empty State */}
        {projects.length === 0 ? (
          <Card className="bg-gradient-card shadow-card p-12 text-center">
            <div className="max-w-md mx-auto space-y-6">
              <div className="w-20 h-20 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto">
                <FolderKanban className="w-10 h-10 text-primary-foreground" />
              </div>
              <div>
                <h3 className="text-2xl font-display font-semibold mb-2">
                  Nenhum projeto ainda
                </h3>
                <p className="text-muted-foreground text-lg">
                  Crie seu primeiro projeto de machine learning e comece a fazer previsões em minutos.
                </p>
              </div>
              <Button 
                size="lg"
                className="bg-gradient-primary hover:shadow-hover transition-all"
              >
                <Plus className="w-5 h-5 mr-2" />
                Criar Primeiro Projeto
              </Button>
            </div>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Project cards will be rendered here */}
          </div>
        )}

        {/* Quick Actions */}
        <div className="mt-12 grid md:grid-cols-3 gap-6">
          <Card className="bg-gradient-card shadow-card p-6 hover:shadow-hover transition-all">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <Brain className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">Guia Rápido</h3>
                <p className="text-sm text-muted-foreground">
                  Aprenda a criar seu primeiro modelo em 5 minutos
                </p>
              </div>
            </div>
          </Card>

          <Card className="bg-gradient-card shadow-card p-6 hover:shadow-hover transition-all">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-secondary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <MessageSquare className="w-6 h-6 text-secondary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">Chatbot IA</h3>
                <p className="text-sm text-muted-foreground">
                  Converse sobre seus projetos e obtenha insights
                </p>
              </div>
            </div>
          </Card>

          <Card className="bg-gradient-card shadow-card p-6 hover:shadow-hover transition-all">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <FolderKanban className="w-6 h-6 text-accent" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">Documentação</h3>
                <p className="text-sm text-muted-foreground">
                  Acesse exemplos e melhores práticas
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
