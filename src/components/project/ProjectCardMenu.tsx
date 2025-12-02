import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { MoreVertical, FolderOpen, Edit, Trash2 } from "lucide-react";
import DeleteProjectDialog from "./DeleteProjectDialog";

interface ProjectCardMenuProps {
  projectId: string;
  projectName: string;
  onDeleted: () => void;
}

const ProjectCardMenu = ({ projectId, projectName, onDeleted }: ProjectCardMenuProps) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleOpenProject = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/projeto/${projectId}`);
  };

  const handleEditProject = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/projeto/${projectId}/wizard`);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteDialog(true);
  };

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

      onDeleted();
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={handleOpenProject}>
            <FolderOpen className="w-4 h-4 mr-2" />
            Abrir projeto
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleEditProject}>
            <Edit className="w-4 h-4 mr-2" />
            Editar projeto
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleDeleteClick}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Excluir projeto
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteProjectDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        projectName={projectName}
        onConfirm={handleDeleteProject}
        isDeleting={isDeleting}
      />
    </>
  );
};

export default ProjectCardMenu;
