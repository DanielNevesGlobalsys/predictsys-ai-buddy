import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cpu, Play, Clock, CheckCircle, Loader2 } from "lucide-react";
import type { ProjectData } from "../WizardContainer";

interface StepTrainingProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
  saveProject: (data: Partial<ProjectData>, nextStep?: number) => Promise<void>;
}

const ALGORITHMS = [
  {
    name: "Logistic Regression",
    description: "Modelo linear simples e interpretável",
    type: "classification",
  },
  {
    name: "Random Forest",
    description: "Ensemble de árvores de decisão",
    type: "both",
  },
  {
    name: "Gradient Boosting",
    description: "Boosting sequencial de árvores",
    type: "both",
  },
  {
    name: "XGBoost",
    description: "Gradient boosting otimizado",
    type: "both",
  },
  {
    name: "Linear Regression",
    description: "Modelo linear para valores contínuos",
    type: "regression",
  },
];

const StepTraining = ({
  projectData,
  onNext,
  onBack,
  loading,
  saveProject,
}: StepTrainingProps) => {
  const [isTraining, setIsTraining] = useState(false);
  const [trainingComplete, setTrainingComplete] = useState(
    projectData.status === "training" || projectData.status === "evaluated"
  );

  const filteredAlgorithms = ALGORITHMS.filter(
    (algo) =>
      algo.type === "both" || algo.type === projectData.problem_type
  );

  const handleStartTraining = async () => {
    setIsTraining(true);
    await saveProject({ status: "training" });
    
    // Simulate training (will be replaced with real ML later)
    setTimeout(() => {
      setIsTraining(false);
      setTrainingComplete(true);
    }, 2000);
  };

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Cpu className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            Treinamento de Modelos
          </h2>
          <p className="text-muted-foreground">
            O sistema vai treinar automaticamente vários algoritmos e encontrar o melhor modelo
          </p>
        </div>

        {/* Info about AutoML */}
        <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-secondary">Como funciona?</strong> O PredictSys vai treinar 
            automaticamente vários algoritmos de machine learning com seus dados e comparar 
            os resultados. Você não precisa saber programar ou conhecer os detalhes técnicos!
          </p>
        </div>

        {/* Algorithms that will be tested */}
        <div className="space-y-3">
          <h3 className="font-semibold">Algoritmos que serão testados:</h3>
          <div className="grid gap-3">
            {filteredAlgorithms.map((algo) => (
              <div
                key={algo.name}
                className="flex items-center gap-4 p-4 bg-muted/30 rounded-lg"
              >
                <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                  <Cpu className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">{algo.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {algo.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Training status */}
        <div className="text-center py-8">
          {!isTraining && !trainingComplete && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-muted rounded-2xl flex items-center justify-center mx-auto">
                <Clock className="w-10 h-10 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold text-lg">Pronto para treinar</p>
                <p className="text-muted-foreground">
                  Clique no botão abaixo para iniciar o treinamento
                </p>
              </div>
              <Button
                size="lg"
                onClick={handleStartTraining}
                className="bg-gradient-primary hover:shadow-hover transition-all"
              >
                <Play className="w-5 h-5 mr-2" />
                Treinar Modelos
              </Button>
            </div>
          )}

          {isTraining && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto">
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              </div>
              <div>
                <p className="font-semibold text-lg">Treinando modelos...</p>
                <p className="text-muted-foreground">
                  Isso pode levar alguns minutos. Por favor, aguarde.
                </p>
              </div>
            </div>
          )}

          {trainingComplete && (
            <div className="space-y-4">
              <div className="w-20 h-20 bg-accent/10 rounded-2xl flex items-center justify-center mx-auto">
                <CheckCircle className="w-10 h-10 text-accent" />
              </div>
              <div>
                <p className="font-semibold text-lg text-accent">
                  Treinamento concluído!
                </p>
                <p className="text-muted-foreground">
                  Os modelos foram treinados com sucesso. Continue para ver os resultados.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Placeholder for results */}
        {trainingComplete && (
          <div className="bg-muted/30 rounded-xl p-6">
            <h3 className="font-semibold mb-4">Comparação de Modelos</h3>
            <div className="h-32 bg-muted/50 rounded-lg flex items-center justify-center">
              <p className="text-muted-foreground text-sm">
                A comparação dos modelos será exibida aqui
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading || isTraining}>
            Voltar
          </Button>
          <Button
            onClick={() => onNext()}
            disabled={loading || isTraining}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            Próximo
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepTraining;
