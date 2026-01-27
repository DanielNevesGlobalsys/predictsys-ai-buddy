import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  BookOpen,
  Lightbulb,
  GitBranch,
  BarChart3,
  MessageSquare,
  HelpCircle,
  TrendingUp,
  Shield,
  CheckCircle2,
} from "lucide-react";

const Documentation = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState("introducao");

  const sections = [
    { id: "introducao", titleKey: "documentation.sections.intro", icon: BookOpen },
    { id: "conceitos", titleKey: "documentation.sections.concepts", icon: Lightbulb },
    { id: "fluxo", titleKey: "documentation.sections.flow", icon: GitBranch },
    { id: "metricas", titleKey: "documentation.sections.metrics", icon: BarChart3 },
    { id: "impacto", titleKey: "documentation.sections.businessImpact", icon: TrendingUp },
    { id: "governanca", titleKey: "documentation.sections.governance", icon: Shield },
    { id: "assistente", titleKey: "documentation.sections.assistant", icon: MessageSquare },
    { id: "faq", titleKey: "documentation.sections.faq", icon: HelpCircle },
  ];

  const concepts = [
    "project", "dataset", "target", "features", "eda", "production", 
    "organization", "businessImpact", "dataGovernance"
  ];

  const flowStepNumbers = ["1", "2", "3", "4", "5", "6"];

  const classificationMetrics = ["AUC", "F1", "Precision", "Recall", "Accuracy"];
  const regressionMetrics = ["MAE", "MSE", "RMSE", "R2"];

  const faqNumbers = ["q1", "q2", "q3", "q4", "q5", "q6"];

  const governanceTopics = ["isolation", "audit", "retention", "transparency"];

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
          <h1 className="text-xl font-bold">{t("documentation.title")}</h1>
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
                    {t(section.titleKey)}
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
                  {t("documentation.sections.introduction")}
                </h2>
                <p className="text-muted-foreground leading-relaxed mb-4">
                  {t("documentation.introText")}
                </p>
                <p className="text-muted-foreground leading-relaxed">
                  {t("documentation.introTextExtra")}
                </p>
              </Card>
            </section>

            {/* Conceitos básicos */}
            <section id="conceitos">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <Lightbulb className="w-6 h-6 text-primary" />
                  {t("documentation.sections.concepts")}
                </h2>
                <div className="space-y-4">
                  {concepts.map((key) => (
                    <div key={key} className="border-l-2 border-primary/30 pl-4">
                      <h4 className="font-semibold">{t(`documentation.concepts.${key}.term`)}</h4>
                      <p className="text-sm text-muted-foreground">{t(`documentation.concepts.${key}.desc`)}</p>
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
                  {t("documentation.sections.flow")}
                </h2>
                <ol className="space-y-3 list-decimal list-inside text-muted-foreground">
                  {flowStepNumbers.map((stepNum) => (
                    <li key={stepNum}>{t(`documentation.flowSteps.${stepNum}`)}</li>
                  ))}
                </ol>
                <div className="mt-4 p-3 bg-muted/50 rounded-lg border border-border/50">
                  <p className="text-sm text-muted-foreground italic">
                    {t("documentation.flowNote")}
                  </p>
                </div>
              </Card>
            </section>

            {/* Métricas */}
            <section id="metricas">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <BarChart3 className="w-6 h-6 text-primary" />
                  {t("documentation.sections.metrics")}
                </h2>

                <div className="mb-4 p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
                  <p className="text-sm text-muted-foreground">
                    {t("documentation.metricsNote")}
                  </p>
                </div>

                <div className="space-y-6">
                  <div>
                    <h3 className="font-semibold mb-3">{t("documentation.metricsClassification")}</h3>
                    <div className="space-y-3">
                      {classificationMetrics.map((metric) => (
                        <div key={metric} className="border-l-2 border-primary/30 pl-4">
                          <h4 className="font-medium">{metric}</h4>
                          <p className="text-sm text-muted-foreground">
                            {t(`documentation.metrics.${metric}`)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-3">{t("documentation.metricsRegression")}</h3>
                    <div className="space-y-3">
                      {regressionMetrics.map((metric) => (
                        <div key={metric} className="border-l-2 border-secondary/30 pl-4">
                          <h4 className="font-medium">{metric}</h4>
                          <p className="text-sm text-muted-foreground">
                            {t(`documentation.metrics.${metric}`)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
            </section>

            {/* Impacto de Negócio */}
            <section id="impacto">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <TrendingUp className="w-6 h-6 text-primary" />
                  {t("documentation.businessImpactTitle")}
                </h2>
                <p className="text-muted-foreground leading-relaxed mb-4">
                  {t("documentation.businessImpactText")}
                </p>
                <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20">
                  <p className="text-sm text-muted-foreground italic">
                    {t("documentation.businessImpactNote")}
                  </p>
                </div>
              </Card>
            </section>

            {/* Governança & LGPD */}
            <section id="governanca">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <Shield className="w-6 h-6 text-primary" />
                  {t("documentation.governanceTitle")}
                </h2>
                <p className="text-muted-foreground leading-relaxed mb-4">
                  {t("documentation.governanceText")}
                </p>
                <div className="space-y-3">
                  {governanceTopics.map((topic) => (
                    <div key={topic} className="flex items-start gap-3">
                      <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5 flex-shrink-0" />
                      <p className="text-sm text-muted-foreground">
                        {t(`documentation.governanceTopics.${topic}`)}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            </section>

            {/* Assistente IA */}
            <section id="assistente">
              <Card className="bg-gradient-card shadow-card p-6">
                <h2 className="text-2xl font-display font-bold mb-4 flex items-center gap-2">
                  <MessageSquare className="w-6 h-6 text-primary" />
                  {t("documentation.sections.assistant")}
                </h2>
                <div className="space-y-4">
                  <div className="border-l-2 border-primary/30 pl-4">
                    <h4 className="font-semibold">{t("documentation.assistantProject.title")}</h4>
                    <p className="text-sm text-muted-foreground">
                      {t("documentation.assistantProject.desc")}
                    </p>
                  </div>
                  <div className="border-l-2 border-secondary/30 pl-4">
                    <h4 className="font-semibold">{t("documentation.assistantGlobal.title")}</h4>
                    <p className="text-sm text-muted-foreground">
                      {t("documentation.assistantGlobal.desc")}
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
                  {t("documentation.sections.faq")}
                </h2>
                <div className="space-y-4">
                  {faqNumbers.map((qNum) => (
                    <div key={qNum} className="border-b border-border/40 pb-4 last:border-0 last:pb-0">
                      <h4 className="font-semibold mb-2">{t(`documentation.faq.${qNum}.question`)}</h4>
                      <p className="text-sm text-muted-foreground">{t(`documentation.faq.${qNum}.answer`)}</p>
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
                {t("documentation.backToProjects")}
              </Button>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};

export default Documentation;
