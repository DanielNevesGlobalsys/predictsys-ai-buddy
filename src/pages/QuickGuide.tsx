import { useTranslation } from "react-i18next";
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

const QuickGuide = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const steps = [
    { number: 1, titleKey: "quickGuide.steps.step1.title", contentKey: "quickGuide.steps.step1.content", icon: Brain },
    { number: 2, titleKey: "quickGuide.steps.step2.title", contentKey: "quickGuide.steps.step2.content", icon: FileSpreadsheet },
    { number: 3, titleKey: "quickGuide.steps.step3.title", contentKey: "quickGuide.steps.step3.content", icon: BarChart3 },
    { number: 4, titleKey: "quickGuide.steps.step4.title", contentKey: "quickGuide.steps.step4.content", icon: Target },
    { number: 5, titleKey: "quickGuide.steps.step5.title", contentKey: "quickGuide.steps.step5.content", icon: Cpu },
    { number: 6, titleKey: "quickGuide.steps.step6.title", contentKey: "quickGuide.steps.step6.content", icon: Rocket },
  ];

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
          <h1 className="text-xl font-bold">{t("quickGuide.title")}</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <Card className="bg-gradient-card shadow-card p-8 mb-8">
          <h1 className="text-3xl font-display font-bold mb-2 text-center">
            {t("quickGuide.subtitle")}
          </h1>
          <p className="text-muted-foreground text-center text-lg">
            {t("quickGuide.description")}
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
                    {t(step.titleKey)}
                  </h3>
                  <p className="text-muted-foreground whitespace-pre-line">{t(step.contentKey)}</p>
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
                {t("quickGuide.tip")}
              </h3>
              <p className="text-muted-foreground">
                {t("quickGuide.tipContent")}
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
            {t("quickGuide.backToProjects")}
          </Button>
        </div>
      </main>
    </div>
  );
};

export default QuickGuide;
