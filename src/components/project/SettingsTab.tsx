import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Trash2, MessageSquareX, AlertTriangle } from "lucide-react";
import DeleteProjectDialog from "./DeleteProjectDialog";
import ClearChatDialog from "./ClearChatDialog";

interface SettingsTabProps {
  projectId: string;
  projectName: string;
  onChatCleared?: () => void;
}

const SettingsTab = ({ projectId, projectName, onChatCleared }: SettingsTabProps) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showClearChatDialog, setShowClearChatDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const handleDeleteProject = async () => {
    setIsDeleting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({
          title: "Erro",
          description: "Você precisa estar logado para excluir um projeto.",
          variant: "destructive",
        });
        return;
      }

      const response = await supabase.functions.invoke("delete-project", {
        body: { project_id: projectId },
      });

      if (response.error || !response.data?.success) {
        throw new Error(response.data?.error || response.error?.message || "Erro ao excluir projeto");
      }

      toast({
        title: "Projeto excluído",
        description: "Projeto excluído com sucesso.",
      });

      navigate("/dashboard");
    } catch (error: any) {
      toast({
        title: "Erro ao excluir projeto",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const handleClearChat = async () => {
    setIsClearing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({
          title: "Erro",
          description: "Você precisa estar logado para limpar o histórico.",
          variant: "destructive",
        });
        return;
      }

      const response = await supabase.functions.invoke("clear-project-chat", {
        body: { project_id: projectId },
      });

      if (response.error || !response.data?.success) {
        throw new Error(response.data?.error || response.error?.message || "Erro ao limpar histórico");
      }

      toast({
        title: "Histórico limpo",
        description: "Histórico do Assistente IA limpo com sucesso.",
      });

      onChatCleared?.();
    } catch (error: any) {
      toast({
        title: "Erro ao limpar histórico",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsClearing(false);
      setShowClearChatDialog(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="bg-gradient-card shadow-card p-6">
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-destructive" />
          Ações do Projeto
        </h3>
        <p className="text-sm text-muted-foreground mb-6">
          Ações irreversíveis que afetam este projeto. Use com cuidado.
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 border border-border rounded-lg">
            <div>
              <h4 className="font-medium">Limpar histórico do Assistente IA</h4>
              <p className="text-sm text-muted-foreground">
                Remove todas as mensagens do chat, mas mantém dados e modelos.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setShowClearChatDialog(true)}
            >
              <MessageSquareX className="w-4 h-4 mr-2" />
              Limpar histórico
            </Button>
          </div>

          <div className="flex items-center justify-between p-4 border border-destructive/50 rounded-lg bg-destructive/5">
            <div>
              <h4 className="font-medium text-destructive">Excluir este projeto</h4>
              <p className="text-sm text-muted-foreground">
                Remove permanentemente o projeto, dados, modelos e histórico.
              </p>
            </div>
            <Button
              variant="destructive"
              onClick={() => setShowDeleteDialog(true)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Excluir projeto
            </Button>
          </div>
        </div>
      </Card>

      <DeleteProjectDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        projectName={projectName}
        onConfirm={handleDeleteProject}
        isDeleting={isDeleting}
      />

      <ClearChatDialog
        open={showClearChatDialog}
        onOpenChange={setShowClearChatDialog}
        onConfirm={handleClearChat}
        isClearing={isClearing}
      />
    </div>
  );
};

export default SettingsTab;
