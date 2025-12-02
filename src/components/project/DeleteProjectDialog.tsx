import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";

interface DeleteProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  onConfirm: () => void;
  isDeleting: boolean;
}

const DeleteProjectDialog = ({
  open,
  onOpenChange,
  projectName,
  onConfirm,
  isDeleting,
}: DeleteProjectDialogProps) => {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir projeto</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>
              Tem certeza que deseja excluir o projeto <strong>"{projectName}"</strong>?
            </p>
            <p>Esta ação é permanente e também vai apagar:</p>
            <ul className="list-disc list-inside space-y-1 text-sm">
              <li>Modelos e métricas de treino</li>
              <li>Estatísticas de EDA</li>
              <li>Arquivo de dados associado</li>
              <li>Histórico do Assistente IA deste projeto</li>
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Excluindo...
              </>
            ) : (
              "Excluir definitivamente"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default DeleteProjectDialog;
