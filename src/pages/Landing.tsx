import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { Shield, TrendingUp, LayoutDashboard, Database, Cpu, Target, Eye, BarChart3, CheckCircle, ArrowRight, Crosshair, Activity, Lock, RefreshCw, Compass, ShieldCheck, DollarSign, ClipboardList } from "lucide-react";
import GlobalControls from "@/components/layout/GlobalControls";
import PredictSysLogo from "@/components/PredictSysLogo";
import { useEffect, useRef, useState } from "react";

const GradientText = ({ children }: { children: React.ReactNode }) => (
  <span className="bg-gradient-primary bg-clip-text text-transparent">{children}</span>
);

const useInView = (threshold = 0.15) => {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setInView(true); obs.disconnect(); } }, { threshold });
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
};

const Landing = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const howItWorksView = useInView(0.2);

  const pillars = [
    { icon: Target, titleKey: "landing.pillars.strategy.title", descKey: "landing.pillars.strategy.desc", itemsKey: "landing.pillars.strategy.items", color: "text-primary" },
    { icon: Crosshair, titleKey: "landing.pillars.decision.title", descKey: "landing.pillars.decision.desc", itemsKey: "landing.pillars.decision.items", color: "text-accent" },
    { icon: TrendingUp, titleKey: "landing.pillars.impact.title", descKey: "landing.pillars.impact.desc", itemsKey: "landing.pillars.impact.items", color: "text-primary" },
  ];

  const strategicCards = [
    { icon: Compass, titleKey: "landing.strategic.guided.title", descKey: "landing.strategic.guided.desc" },
    { icon: ShieldCheck, titleKey: "landing.strategic.guardrails.title", descKey: "landing.strategic.guardrails.desc" },
    { icon: DollarSign, titleKey: "landing.strategic.impact.title", descKey: "landing.strategic.impact.desc" },
    { icon: ClipboardList, titleKey: "landing.strategic.audit.title", descKey: "landing.strategic.audit.desc" },
  ];

  const features = [
    { icon: Cpu, titleKey: "landing.features.automl", descKey: "landing.features.automlDesc" },
    { icon: Shield, titleKey: "landing.features.guardrails", descKey: "landing.features.guardrailsDesc" },
    { icon: Activity, titleKey: "landing.features.governance", descKey: "landing.features.governanceDesc" },
    { icon: Eye, titleKey: "landing.features.observability", descKey: "landing.features.observabilityDesc" },
    { icon: LayoutDashboard, titleKey: "landing.features.segmentation", descKey: "landing.features.segmentationDesc" },
    { icon: BarChart3, titleKey: "landing.features.impactMeasure", descKey: "landing.features.impactMeasureDesc" },
    { icon: Lock, titleKey: "landing.features.security", descKey: "landing.features.securityDesc" },
    { icon: RefreshCw, titleKey: "landing.features.learning", descKey: "landing.features.learningDesc" },
  ];

  const steps = [
    { number: "1", titleKey: "landing.howItWorks.step1.title", descKey: "landing.howItWorks.step1.desc" },
    { number: "2", titleKey: "landing.howItWorks.step2.title", descKey: "landing.howItWorks.step2.desc" },
    { number: "3", titleKey: "landing.howItWorks.step3.title", descKey: "landing.howItWorks.step3.desc" },
    { number: "4", titleKey: "landing.howItWorks.step4.title", descKey: "landing.howItWorks.step4.desc" },
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
            <Button variant="ghost" onClick={() => navigate("/auth")} className="hover:bg-primary/10">
              {t("auth.login")}
            </Button>
            <Button onClick={() => navigate("/auth")} className="bg-gradient-primary hover:shadow-hover transition-all">
              {t("landing.startFree")}
            </Button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 text-center">
        <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-1000">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 rounded-full text-sm font-medium text-primary mb-4">
            <Target className="w-4 h-4" />
            <span>{t("landing.predictiveAI")}</span>
          </div>
          
          <h1 className="text-4xl md:text-[3.6rem] font-display font-bold leading-tight">
            {t("landing.heroTitle1Part1")}{" "}
            <GradientText>{t("landing.heroTitle1Part2")}</GradientText>
          </h1>
          
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed">
            {t("landing.heroSubtitle")}
          </p>
          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Button size="lg" onClick={() => navigate("/auth")} className="bg-gradient-primary hover:shadow-hover transition-all text-lg px-8 py-6">
              {t("landing.createFreeAccount")}
            </Button>
            <Button size="lg" variant="outline" className="text-lg px-8 py-6 border-2 hover:bg-primary/5">
              {t("landing.viewDemo")}
            </Button>
          </div>

          <div className="flex items-center justify-center gap-8 pt-8 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-accent" />
              <span>{t("landing.secure")}</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-accent" />
              <span>{t("landing.governedPipeline")}</span>
            </div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-accent" />
              <span>{t("landing.measurableImpact")}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Problem Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-3xl mx-auto text-center space-y-6">
          <h2 className="text-4xl font-display font-bold leading-tight">
            {t("landing.problem.title1")}
            <br />
            <GradientText>{t("landing.problem.title2")}</GradientText>
          </h2>
          <p className="text-xl text-muted-foreground leading-relaxed">
            {t("landing.problem.text")}
          </p>
        </div>
      </section>

      {/* 3 Pillars */}
      <section className="container mx-auto px-4 py-20">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-display font-bold mb-4">
            {t("landing.pillarsTitle1")}{" "}
            <GradientText>{t("landing.pillarsTitle2")}</GradientText>
          </h2>
        </div>
        <div className="grid md:grid-cols-3 gap-8">
          {pillars.map((pillar, index) => {
            const Icon = pillar.icon;
            const items = t(pillar.itemsKey, { returnObjects: true }) as string[];
            return (
              <div key={index} className="group bg-gradient-card rounded-2xl p-8 shadow-card hover:shadow-hover transition-all duration-300 hover:-translate-y-1">
                <div className="w-14 h-14 bg-gradient-primary rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <Icon className="w-7 h-7 text-primary-foreground" />
                </div>
                <h3 className="text-2xl font-display font-semibold mb-3">{t(pillar.titleKey)}</h3>
                <p className="text-muted-foreground mb-4">{t(pillar.descKey)}</p>
                <ul className="space-y-2">
                  {Array.isArray(items) && items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <CheckCircle className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* Strategic Cards (NEW — complementary) */}
      <section className="container mx-auto px-4 py-20">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-display font-bold mb-4">
            {t("landing.strategicTitle1")}{" "}
            <GradientText>{t("landing.strategicTitle2")}</GradientText>
          </h2>
          <p className="text-xl text-muted-foreground">{t("landing.strategicSubtitle")}</p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {strategicCards.map((card, index) => {
            const Icon = card.icon;
            return (
              <div key={index} className="group bg-gradient-card rounded-2xl p-8 shadow-card hover:shadow-hover transition-all duration-300 hover:-translate-y-1">
                <div className="w-14 h-14 bg-gradient-primary rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <Icon className="w-7 h-7 text-primary-foreground" />
                </div>
                <h3 className="text-xl font-display font-semibold mb-3">{t(card.titleKey)}</h3>
                <p className="text-muted-foreground leading-relaxed">{t(card.descKey)}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Features Grid (existing — kept intact) */}
      <section className="container mx-auto px-4 py-20">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-display font-bold mb-4">
            {t("landing.allYouNeed1")}{" "}
            <GradientText>{t("landing.allYouNeed2")}</GradientText>
          </h2>
          <p className="text-xl text-muted-foreground">{t("landing.autoMLDescription")}</p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div key={index} className="group bg-gradient-card rounded-2xl p-8 shadow-card hover:shadow-hover transition-all duration-300 hover:-translate-y-1" style={{ animationDelay: `${index * 100}ms` }}>
                <div className="w-14 h-14 bg-gradient-primary rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <Icon className="w-7 h-7 text-primary-foreground" />
                </div>
                <h3 className="text-xl font-display font-semibold mb-3">{t(feature.titleKey)}</h3>
                <p className="text-muted-foreground leading-relaxed">{t(feature.descKey)}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* How It Works — animated with connecting line */}
      <section className="container mx-auto px-4 py-20">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-display font-bold mb-4">
            {t("landing.howItWorks.titlePart1")}{" "}
            <GradientText>{t("landing.howItWorks.titlePart2")}</GradientText>
          </h2>
        </div>
        <div ref={howItWorksView.ref} className="relative">
          {/* Connecting line (desktop only) */}
          <div className="hidden lg:block absolute top-[2.25rem] left-[12.5%] right-[12.5%] h-0.5 bg-border/60 z-0">
            <div
              className="h-full bg-gradient-primary transition-all duration-[1.5s] ease-out"
              style={{ width: howItWorksView.inView ? "100%" : "0%" }}
            />
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 relative z-10">
            {steps.map((step, index) => (
              <div
                key={index}
                className={`relative bg-gradient-card rounded-2xl p-8 shadow-card transition-all duration-500 hover:shadow-[0_0_20px_-4px_hsl(var(--primary)/0.3)] group ${
                  howItWorksView.inView
                    ? "opacity-100 translate-y-0"
                    : "opacity-0 translate-y-6"
                }`}
                style={{ transitionDelay: howItWorksView.inView ? `${index * 200}ms` : "0ms" }}
              >
                <div className="w-11 h-11 bg-gradient-primary rounded-full flex items-center justify-center mb-4 text-primary-foreground font-bold text-lg transition-transform duration-300 group-hover:scale-110">
                  {step.number}
                </div>
                <h3 className="text-lg font-display font-semibold mb-2">{t(step.titleKey)}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{t(step.descKey)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Institutional Block */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-3xl mx-auto text-center space-y-6">
          <h2 className="text-4xl font-display font-bold">
            {t("landing.institutional.title1")}{" "}
            <GradientText>{t("landing.institutional.title2")}</GradientText>
          </h2>
          <p className="text-xl text-muted-foreground leading-relaxed whitespace-pre-line">
            {t("landing.institutional.text")}
          </p>
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
          <Button size="lg" onClick={() => navigate("/auth")} className="bg-background text-foreground hover:bg-background/90 text-lg px-8 py-6">
            {t("landing.startNow")}
          </Button>
        </div>
      </section>

      {/* Footer Tagline + Footer */}
      <div className="container mx-auto px-4 py-8 text-center">
        <p className="text-lg font-display font-semibold bg-gradient-primary bg-clip-text text-transparent">
          {t("landing.tagline")}
        </p>
      </div>

      <footer className="border-t border-border/40 bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <PredictSysLogo size="sm" />
              <span className="font-semibold">PredictSys AI</span>
            </div>
            <p className="text-sm text-muted-foreground">{t("landing.footer")}</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
