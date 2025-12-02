import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BarChart3 } from "lucide-react";
import type { ProjectData } from "../WizardContainer";
import EDADisplay from "@/components/eda/EDADisplay";

interface StepEDAProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
}

const StepEDA = ({ projectData, onNext, onBack, loading }: StepEDAProps) => {
  const handleEDAComplete = () => {
    // EDA was calculated successfully
  };

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            Análise Exploratória (EDA)
          </h2>
          <p className="text-muted-foreground">
            Entenda melhor seus dados com estatísticas e gráficos simples
          </p>
        </div>

        {/* Info message */}
        <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-secondary">O que é EDA?</strong> A Análise Exploratória de Dados 
            ajuda você a entender as características dos seus dados antes de treinar o modelo. 
            Você verá distribuições, valores ausentes e muito mais.
          </p>
        </div>

        {/* EDA Display */}
        {projectData.id ? (
          <EDADisplay projectId={projectData.id} onEDAComplete={handleEDAComplete} />
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            Salve o projeto primeiro para calcular a EDA.
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            Voltar
          </Button>
          <Button
            onClick={() => onNext({ status: "eda_complete" })}
            disabled={loading}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            Próximo
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepEDA;
