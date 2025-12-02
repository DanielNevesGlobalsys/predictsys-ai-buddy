import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BarChart3, Table, PieChart, TrendingUp } from "lucide-react";
import type { ProjectData } from "../WizardContainer";

interface StepEDAProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
}

const StepEDA = ({ projectData, onNext, onBack, loading }: StepEDAProps) => {
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
            Aqui você verá estatísticas e gráficos dos seus dados para entender melhor o dataset
          </p>
        </div>

        {/* Info message */}
        <div className="p-4 bg-secondary/10 border border-secondary/20 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong className="text-secondary">O que é EDA?</strong> A Análise Exploratória de Dados 
            ajuda você a entender as características dos seus dados antes de treinar o modelo. 
            Você verá distribuições, valores ausentes, correlações e muito mais.
          </p>
        </div>

        {/* Placeholder sections */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Colunas e tipos */}
          <div className="bg-muted/30 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <Table className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold">Colunas e Tipos</h3>
                <p className="text-sm text-muted-foreground">Lista de variáveis</p>
              </div>
            </div>
            <div className="h-32 bg-muted/50 rounded-lg flex items-center justify-center">
              <p className="text-muted-foreground text-sm">
                Será exibido após upload dos dados
              </p>
            </div>
          </div>

          {/* Estatísticas numéricas */}
          <div className="bg-muted/30 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-secondary/10 rounded-lg flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-secondary" />
              </div>
              <div>
                <h3 className="font-semibold">Estatísticas Numéricas</h3>
                <p className="text-sm text-muted-foreground">Média, mediana, desvio</p>
              </div>
            </div>
            <div className="h-32 bg-muted/50 rounded-lg flex items-center justify-center">
              <p className="text-muted-foreground text-sm">
                Será exibido após upload dos dados
              </p>
            </div>
          </div>

          {/* Histogramas */}
          <div className="bg-muted/30 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center">
                <BarChart3 className="w-5 h-5 text-accent" />
              </div>
              <div>
                <h3 className="font-semibold">Histogramas</h3>
                <p className="text-sm text-muted-foreground">Distribuição dos dados</p>
              </div>
            </div>
            <div className="h-32 bg-muted/50 rounded-lg flex items-center justify-center">
              <p className="text-muted-foreground text-sm">
                Será exibido após upload dos dados
              </p>
            </div>
          </div>

          {/* Gráficos de barras */}
          <div className="bg-muted/30 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-destructive/10 rounded-lg flex items-center justify-center">
                <PieChart className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <h3 className="font-semibold">Categorias</h3>
                <p className="text-sm text-muted-foreground">Variáveis categóricas</p>
              </div>
            </div>
            <div className="h-32 bg-muted/50 rounded-lg flex items-center justify-center">
              <p className="text-muted-foreground text-sm">
                Será exibido após upload dos dados
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            Voltar
          </Button>
          <Button
            onClick={() => onNext()}
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
