import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNavigate } from "react-router-dom";
import {
  Brain,
  ChevronLeft,
  FileSpreadsheet,
  BarChart3,
  Target,
  Cpu,
  Rocket,
  MessageSquare,
  Lightbulb,
} from "lucide-react";

const steps = [
  {
    number: 1,
    title: "Crie um novo projeto",
    icon: Brain,
    content: `Clique em "Novo Projeto" e preencha:
• Nome do projeto (ex.: "Previsão de churn clientes")
• Descrição do que você quer prever
• Objetivo de negócio em linguagem simples
• Tipo de problema: Classificação (0/1) ou Regressão (valor numérico)`,
  },
  {
    number: 2,
    title: "Envie seus dados (CSV)",
    icon: FileSpreadsheet,
    content: `No passo "Dados", envie um arquivo CSV com suas informações.
A PredictSys vai detectar automaticamente colunas numéricas e categóricas e mostrar uma pré-visualização das primeiras linhas.`,
  },
  {
    number: 3,
    title: "Entenda seu dataset (EDA)",
    icon: BarChart3,
    content: `No passo "Análise (EDA)", clique em "Calcular EDA".
Você verá estatísticas e gráficos que ajudam a entender seus dados: distribuição de valores, variáveis categóricas mais frequentes, dados ausentes etc.`,
  },
  {
    number: 4,
    title: "Escolha a variável alvo e features",
    icon: Target,
    content: `No passo "Variáveis", selecione a coluna que você quer prever (variável alvo) e quais colunas serão usadas como entrada do modelo (features).
Se tiver dúvidas, o Assistente IA pode explicar cada métrica e conceito.`,
  },
  {
    number: 5,
    title: "Treine o modelo",
    icon: Cpu,
    content: `No passo "Treinamento", clique em "Treinar modelos".
A PredictSys testa automaticamente diferentes algoritmos e apresenta uma tabela comparando AUC, F1, Precisão, Recall e Acurácia (para classificação) ou MAE/RMSE/R² (para regressão).`,
  },
  {
    number: 6,
    title: "Coloque o modelo em produção",
    icon: Rocket,
    content: `Escolha o melhor modelo e publique em produção com 1 clique.
Em "API & Deploy" você encontra o endpoint de predição e exemplos de como integrar seu sistema.`,
  },
];

const QuickGuide = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gradient-hero">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="w-10 h-10 bg-gradient-primary rounded-xl flex items-center justify-center">
            <Brain className="w-6 h-6 text-primary-foreground" />
          </div>
          <h1 className="text-xl font-bold">Guia Rápido</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <Card className="bg-gradient-card shadow-card p-8 mb-8">
          <h1 className="text-3xl font-display font-bold mb-2 text-center">
            Seu primeiro modelo em 5 minutos
          </h1>
          <p className="text-muted-foreground text-center text-lg">
            Siga os passos abaixo para criar seu primeiro modelo de machine learning na PredictSys AI
          </p>
        </Card>

        <div className="space-y-6">
          {steps.map((step) => (
            <Card key={step.number} className="bg-gradient-card shadow-card p-6">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-12 h-12 bg-gradient-primary rounded-xl flex items-center justify-center">
                  <step.icon className="w-6 h-6 text-primary-foreground" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
                    <span className="w-7 h-7 bg-primary/10 rounded-full flex items-center justify-center text-sm font-bold text-primary">
                      {step.number}
                    </span>
                    {step.title}
                  </h3>
                  <p className="text-muted-foreground whitespace-pre-line">{step.content}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Tip section */}
        <Card className="bg-gradient-card shadow-card p-6 mt-8 border-l-4 border-l-primary">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
              <Lightbulb className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold mb-2 flex items-center gap-2">
                <MessageSquare className="w-4 h-4" />
                Dica
              </h3>
              <p className="text-muted-foreground">
                A qualquer momento, você pode abrir o Assistente IA do projeto para pedir explicações 
                em linguagem simples sobre o que foi feito, as métricas e os próximos passos.
              </p>
            </div>
          </div>
        </Card>

        <div className="mt-8 text-center">
          <Button
            size="lg"
            className="bg-gradient-primary hover:shadow-hover transition-all"
            onClick={() => navigate("/dashboard")}
          >
            <ChevronLeft className="w-5 h-5 mr-2" />
            Voltar para Meus Projetos
          </Button>
        </div>
      </main>
    </div>
  );
};

export default QuickGuide;
