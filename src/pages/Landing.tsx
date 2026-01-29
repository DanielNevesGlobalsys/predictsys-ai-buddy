import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { BarChart3, MessageSquare, Zap, Shield, TrendingUp, LayoutDashboard, Database, Cpu } from "lucide-react";
import GlobalControls from "@/components/layout/GlobalControls";
import PredictSysLogo from "@/components/PredictSysLogo";

const Landing = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const features = [
    {
      icon: Cpu,
      titleKey: "landing.features.automl",
      descKey: "landing.features.automlDesc"
    },
    {
      icon: MessageSquare,
      titleKey: "landing.features.chatbot",
      descKey: "landing.features.chatbotDesc"
    },
    {
      icon: BarChart3,
      titleKey: "landing.features.eda",
      descKey: "landing.features.edaDesc"
    },
    {
      icon: Zap,
      titleKey: "landing.features.deploy",
      descKey: "landing.features.deployDesc"
    },
    {
      icon: LayoutDashboard,
      titleKey: "landing.features.dashboards",
      descKey: "landing.features.dashboardsDesc"
    },
    {
      icon: Database,
      titleKey: "landing.features.ingestion",
      descKey: "landing.features.ingestionDesc"
    },
    {
      icon: Shield,
      titleKey: "landing.features.security",
      descKey: "landing.features.securityDesc"
    },
    {
      icon: TrendingUp,
      titleKey: "landing.features.learning",
      descKey: "landing.features.learningDesc"
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-hero">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PredictSysLogo size="md" />
            <h1 className="text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent">
              PredictSys AI
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <GlobalControls />
            <Button 
              variant="ghost" 
              onClick={() => navigate("/auth")}
              className="hover:bg-primary/10"
            >
              {t("auth.login")}
            </Button>
            <Button 
              onClick={() => navigate("/auth")}
              className="bg-gradient-primary hover:shadow-hover transition-all"
            >
              {t("landing.startFree")}
            </Button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 text-center">
        <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-1000">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 rounded-full text-sm font-medium text-primary mb-4">
            <Zap className="w-4 h-4" />
            <span>{t("landing.predictiveAI")}</span>
          </div>
          
          <h1 className="text-5xl md:text-7xl font-display font-bold leading-tight">
            {t("landing.heroTitle1")}
            <br />
            <span className="bg-gradient-primary bg-clip-text text-transparent">
              {t("landing.heroTitle2")}
            </span>
          </h1>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            {t("landing.heroSubtitle")}
          </p>
          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Button 
              size="lg"
              onClick={() => navigate("/auth")}
              className="bg-gradient-primary hover:shadow-hover transition-all text-lg px-8 py-6"
            >
              {t("landing.createFreeAccount")}
            </Button>
            <Button 
              size="lg"
              variant="outline"
              className="text-lg px-8 py-6 border-2 hover:bg-primary/5"
            >
              {t("landing.viewDemo")}
            </Button>
          </div>

          <div className="flex items-center justify-center gap-8 pt-8 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-accent" />
              <span>{t("landing.secure")}</span>
            </div>
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-accent" />
              <span>{t("landing.instantDeploy")}</span>
            </div>
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-accent" />
              <span>{t("landing.aiChatbot")}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="container mx-auto px-4 py-20">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-display font-bold mb-4">
            {t("landing.allYouNeed")}
            <span className="bg-gradient-primary bg-clip-text text-transparent">{t("landing.predictFuture")}</span>
          </h2>
          <p className="text-xl text-muted-foreground">
            {t("landing.autoMLDescription")}
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div
                key={index}
                className="group bg-gradient-card rounded-2xl p-8 shadow-card hover:shadow-hover transition-all duration-300 hover:-translate-y-1"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <div className="w-14 h-14 bg-gradient-primary rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <Icon className="w-7 h-7 text-primary-foreground" />
                </div>
                <h3 className="text-xl font-display font-semibold mb-3">
                  {t(feature.titleKey)}
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  {t(feature.descKey)}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* CTA Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="bg-gradient-primary rounded-3xl p-12 text-center shadow-hover">
          <h2 className="text-4xl font-display font-bold text-primary-foreground mb-4">
            {t("landing.readyToStart")}
          </h2>
          <p className="text-xl text-primary-foreground/90 mb-8 max-w-2xl mx-auto">
            {t("landing.readyDescription")}
          </p>
          <Button 
            size="lg"
            onClick={() => navigate("/auth")}
            className="bg-background text-foreground hover:bg-background/90 text-lg px-8 py-6"
          >
            {t("landing.startNow")}
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/40 bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <PredictSysLogo size="sm" />
              <span className="font-semibold">PredictSys AI</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("landing.footer")}
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
