import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNavigate } from "react-router-dom";
import {
  Brain,
  ChevronLeft,
  BookOpen,
  Lightbulb,
  GitBranch,
  BarChart3,
  MessageSquare,
  HelpCircle,
} from "lucide-react";

const sections = [
  { id: "introducao", title: "Introdução", icon: BookOpen },
  { id: "conceitos", title: "Conceitos básicos", icon: Lightbulb },
  { id: "fluxo", title: "Fluxo de criação", icon: GitBranch },
  { id: "metricas", title: "Métricas do modelo", icon: BarChart3 },
  { id: "assistente", title: "Assistente IA", icon: MessageSquare },
  { id: "faq", title: "Perguntas frequentes", icon: HelpCircle },
];

const METRIC_EXPLANATIONS = {
  classification: {
    AUC: "Mede quão bem o modelo consegue separar quem vai churnar de quem não vai, em todos os limiares possíveis. Vai de 0 a 1: quanto mais perto de 1, melhor. É uma boa métrica quando os dados são desbalanceados (poucos churns).",
    F1: "É a média harmônica entre Precisão e Recall. Resume, em um número só, o equilíbrio entre: quantos churns previstos são realmente churns (Precisão) e quantos churns reais o modelo conseguiu encontrar (Recall).",
    Precisão: "Entre todos os clientes que o modelo disse que vão churnar, qual porcentagem de fato churnou. Útil quando o custo de acionar alguém que não vai churnar é alto.",
    Recall: "Entre todos os clientes que realmente churnaram, qual porcentagem o modelo conseguiu identificar como churn. Útil quando é muito importante NÃO deixar churns passarem despercebidos.",
    Acurácia: "Porcentagem total de acertos do modelo, considerando churn e não churn. Pode ser enganosa se a base for muito desbalanceada (quase ninguém churnando).",
  },
  regression: {
    MAE: "Média da diferença absoluta entre o valor previsto e o valor real. Diz, em média, quanto o modelo erra para mais ou para menos, na mesma unidade da variável alvo.",
    MSE: "Média dos erros ao quadrado. Penaliza mais fortemente erros grandes. Útil para comparar modelos, mas não é tão intuitivo para o negócio.",
    RMSE: "Raiz quadrada do MSE. Fica na mesma unidade da variável alvo e também penaliza bastante os grandes erros.",
    "R²": "Mede o quanto o modelo explica da variação do alvo (de 0 a 1). Quanto mais próximo de 1, mais o modelo explica o comportamento da variável.",
  },
};

const faqItems = [
  {
    question: "Preciso saber programar para usar a PredictSys?",
    answer: "Não! A PredictSys AI foi criada para ser 100% no-code. Todas as etapas são feitas por meio de botões, formulários e seleções visuais. Você não precisa escrever nenhuma linha de código.",
  },
  {
    question: "Qual formato de arquivo é aceito?",
    answer: "Atualmente aceitamos arquivos CSV (valores separados por vírgula) com codificação UTF-8. É o formato mais comum para exportação de dados de planilhas e sistemas.",
  },
  {
    question: "Quantas linhas o meu dataset pode ter?",
    answer: "O arquivo pode ter até 50 MB. Para o treinamento dos modelos, utilizamos até 5.000 linhas para garantir que o processamento seja rápido e eficiente.",
  },
  {
    question: "Posso usar a plataforma para outros casos além de churn?",
    answer: "Sim! A PredictSys serve para qualquer problema de classificação (prever categorias, como sim/não, A/B/C) ou regressão (prever valores numéricos, como vendas, preço). Exemplos: inadimplência, propensão de compra, previsão de vendas, score de crédito.",
  },
  {
    question: "Como funciona a API de predição?",
    answer: "Após publicar um modelo em produção, você recebe um endpoint de API REST. Basta enviar os dados de entrada no formato JSON e receber a predição como resposta. Exemplos de código são fornecidos na aba 'API & Deploy'.",
  },
];

const Documentation = () => {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState("introducao");

  const scrollToSection = (id: string) => {
    setActiveSection(id);
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-hero">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="w-10 h-10 bg-gradient-primary rounded-xl flex items-center justify-center">
            <BookOpen className="w-6 h-6 text-primary-foreground" />
          </div>
          <h1 className="text-xl font-bold">Documentação</h1>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6">
        <div className="flex gap-6">
          {/* Sidebar navigation */}
          <aside className="hidden md:block w-64 flex-shrink-0">
            <Card className="bg-gradient-card shadow-card p-4 sticky top-24">
              <nav className="space-y-1">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => scrollToSection(section.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors text-left ${
                      activeSection === section.id
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <section.icon className="w-4 h-4" />
                    {section.title}
                  </button>
                ))}
              </nav>
            </Card>
          </aside>

          {/* Main content */}
          <main className="flex-1 max-w-3xl space-y-8">
            {/* Introdução */}
            <section id="introducao">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <BookOpen className="w-6 h-6 text-primary" />
                  Introdução
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  A PredictSys AI é uma plataforma de modelos preditivos focada em dados tabulares.
                  Ela permite que usuários de negócio criem projetos de machine learning sem escrever código,
                  passando por etapas de dados, análise, treinamento e deploy de forma guiada.
                </p>
              </Card>
            </section>

            {/* Conceitos básicos */}
            <section id="conceitos">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <Lightbulb className="w-6 h-6 text-primary" />
                  Conceitos básicos
                </h2>
                <div className="space-y-4">
                  {[
                    { term: "Projeto", desc: "Conjunto de dados, modelagem e resultados para um objetivo de negócio específico (ex.: \"Previsão de churn na jornada\")." },
                    { term: "Dataset", desc: "Arquivo CSV com o histórico de clientes, transações ou eventos." },
                    { term: "Variável alvo (target)", desc: "O que você quer prever (ex.: churn_90d, valor de compra, inadimplência)." },
                    { term: "Features", desc: "Colunas usadas como entrada para o modelo (idade do cliente, número de compras, canal etc.)." },
                    { term: "EDA", desc: "Análise Exploratória que mostra estatísticas e gráficos sobre os dados." },
                    { term: "Modelo em produção", desc: "Modelo escolhido para ser usado pela API de predição." },
                  ].map((item) => (
                    <div key={item.term} className="border-l-2 border-primary/30 pl-4">
                      <h4 className="font-semibold">{item.term}</h4>
                      <p className="text-sm text-muted-foreground">{item.desc}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </section>

            {/* Fluxo de criação */}
            <section id="fluxo">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <GitBranch className="w-6 h-6 text-primary" />
                  Fluxo de criação de projeto
                </h2>
                <ol className="space-y-3 list-decimal list-inside text-muted-foreground">
                  <li><strong>Informações do projeto:</strong> Nome, descrição, objetivo e tipo de problema.</li>
                  <li><strong>Upload de dados:</strong> Envie um arquivo CSV com seus dados históricos.</li>
                  <li><strong>Análise exploratória (EDA):</strong> Visualize estatísticas e gráficos dos seus dados.</li>
                  <li><strong>Seleção de variáveis:</strong> Escolha a variável alvo e as features de entrada.</li>
                  <li><strong>Treinamento:</strong> A plataforma treina automaticamente múltiplos algoritmos.</li>
                  <li><strong>Deploy:</strong> Publique o modelo escolhido e obtenha a API de predição.</li>
                </ol>
              </Card>
            </section>

            {/* Métricas */}
            <section id="metricas">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <BarChart3 className="w-6 h-6 text-primary" />
                  Métricas do modelo
                </h2>

                <div className="space-y-6">
                  <div>
                    <h3 className="font-semibold mb-3">Classificação</h3>
                    <div className="space-y-3">
                      {Object.entries(METRIC_EXPLANATIONS.classification).map(([metric, desc]) => (
                        <div key={metric} className="border-l-2 border-primary/30 pl-4">
                          <h4 className="font-medium">{metric}</h4>
                          <p className="text-sm text-muted-foreground">{desc}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-3">Regressão</h3>
                    <div className="space-y-3">
                      {Object.entries(METRIC_EXPLANATIONS.regression).map(([metric, desc]) => (
                        <div key={metric} className="border-l-2 border-secondary/30 pl-4">
                          <h4 className="font-medium">{metric}</h4>
                          <p className="text-sm text-muted-foreground">{desc}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
            </section>

            {/* Assistente IA */}
            <section id="assistente">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <MessageSquare className="w-6 h-6 text-primary" />
                  Assistente IA
                </h2>
                <div className="space-y-4">
                  <div className="border-l-2 border-primary/30 pl-4">
                    <h4 className="font-semibold">Assistente IA do projeto</h4>
                    <p className="text-sm text-muted-foreground">
                      Responde sobre dados, modelos e métricas daquele projeto específico. 
                      Tem acesso ao contexto completo do projeto: dataset, EDA, modelos treinados e feature importance.
                    </p>
                  </div>
                  <div className="border-l-2 border-secondary/30 pl-4">
                    <h4 className="font-semibold">Chatbot IA global</h4>
                    <p className="text-sm text-muted-foreground">
                      Responde sobre uso da plataforma e conceitos gerais de machine learning.
                      Ideal para tirar dúvidas sobre como usar a PredictSys ou entender métricas e termos técnicos.
                    </p>
                  </div>
                </div>
              </Card>
            </section>

            {/* FAQ */}
            <section id="faq">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <HelpCircle className="w-6 h-6 text-primary" />
                  Perguntas frequentes
                </h2>
                <div className="space-y-4">
                  {faqItems.map((item, index) => (
                    <div key={index} className="border-b border-border/40 pb-4 last:border-0 last:pb-0">
                      <h4 className="font-semibold mb-2">{item.question}</h4>
                      <p className="text-sm text-muted-foreground">{item.answer}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </section>

            <div className="text-center pb-8">
              <Button
                size="lg"
                variant="outline"
                onClick={() => navigate("/dashboard")}
              >
                <ChevronLeft className="w-5 h-5 mr-2" />
                Voltar para Meus Projetos
              </Button>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};

export default Documentation;
