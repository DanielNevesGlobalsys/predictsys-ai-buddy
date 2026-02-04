import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Sparkles, 
  TrendingUp, 
  DollarSign, 
  ChevronRight, 
  ChevronLeft 
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import logoBox from '@/assets/logo-box.svg';

interface OnboardingStep {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const AppOnboarding = () => {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right'>('left');

  const steps: OnboardingStep[] = [
    {
      icon: <Sparkles className="w-16 h-16 text-secondary" />,
      title: 'IA traduzindo dados em decisões de negócio',
      description: 'Transforme seus dados brutos em insights estratégicos que impulsionam resultados reais.',
    },
    {
      icon: <TrendingUp className="w-16 h-16 text-accent" />,
      title: 'Risco e oportunidade em tempo real',
      description: 'Identifique clientes em risco de churn e oportunidades de upsell antes que seja tarde.',
    },
    {
      icon: <DollarSign className="w-16 h-16 text-green-500" />,
      title: 'Impacto financeiro das suas ações',
      description: 'Meça o ROI real de cada campanha e ação com métricas claras de negócio.',
    },
  ];

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setSlideDirection('left');
      setIsTransitioning(true);
      setTimeout(() => {
        setCurrentStep((prev) => prev + 1);
        setIsTransitioning(false);
      }, 200);
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setSlideDirection('right');
      setIsTransitioning(true);
      setTimeout(() => {
        setCurrentStep((prev) => prev - 1);
        setIsTransitioning(false);
      }, 200);
    }
  };

  const handleFinish = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        await supabase
          .from('profiles')
          .update({ onboarding_done: true })
          .eq('id', session.user.id);
      }
    } catch (error) {
      console.error('Error updating onboarding status:', error);
    }
    
    navigate('/app/home', { replace: true });
  };

  const isLastStep = currentStep === steps.length - 1;
  const currentStepData = steps[currentStep];

  return (
    <div 
      className="fixed inset-0 flex flex-col"
      style={{
        background: 'linear-gradient(180deg, hsl(222 47% 11%) 0%, hsl(222 47% 8%) 100%)',
      }}
    >
      {/* Header with logo */}
      <header className="flex justify-center pt-12 pb-8">
        <img
          src={logoBox}
          alt="PredictSys AI"
          className="w-16 h-16"
          style={{ filter: 'drop-shadow(0 0 10px hsl(189 85% 52% / 0.3))' }}
        />
      </header>

      {/* Content area */}
      <main className="flex-1 flex flex-col items-center justify-center px-8 max-w-md mx-auto">
        {/* Step content with transition */}
        <div 
          className={`flex flex-col items-center text-center transition-all duration-200 ${
            isTransitioning 
              ? slideDirection === 'left' 
                ? 'opacity-0 -translate-x-8' 
                : 'opacity-0 translate-x-8'
              : 'opacity-100 translate-x-0'
          }`}
        >
          {/* Icon */}
          <div className="mb-8 p-6 rounded-full bg-primary/10">
            {currentStepData.icon}
          </div>

          {/* Title */}
          <h2 className="text-2xl font-bold text-white mb-4 leading-tight">
            {currentStepData.title}
          </h2>

          {/* Description */}
          <p className="text-muted-foreground text-lg leading-relaxed">
            {currentStepData.description}
          </p>
        </div>
      </main>

      {/* Footer with navigation */}
      <footer className="px-8 pb-12 max-w-md mx-auto w-full">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-8">
          {steps.map((_, index) => (
            <button
              key={index}
              onClick={() => {
                setSlideDirection(index > currentStep ? 'left' : 'right');
                setIsTransitioning(true);
                setTimeout(() => {
                  setCurrentStep(index);
                  setIsTransitioning(false);
                }, 200);
              }}
              className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                index === currentStep 
                  ? 'bg-primary w-8' 
                  : 'bg-muted-foreground/30 hover:bg-muted-foreground/50'
              }`}
              aria-label={`Go to step ${index + 1}`}
            />
          ))}
        </div>

        {/* Navigation buttons */}
        <div className="flex gap-4">
          {currentStep > 0 && (
            <Button
              variant="outline"
              size="lg"
              onClick={handlePrev}
              className="flex-1 h-14 text-base"
            >
              <ChevronLeft className="w-5 h-5 mr-2" />
              Voltar
            </Button>
          )}
          
          <Button
            size="lg"
            onClick={isLastStep ? handleFinish : handleNext}
            className="flex-1 h-14 text-base bg-primary hover:bg-primary/90"
          >
            {isLastStep ? (
              'Entrar no App'
            ) : (
              <>
                Próximo
                <ChevronRight className="w-5 h-5 ml-2" />
              </>
            )}
          </Button>
        </div>

        {/* Skip button */}
        {!isLastStep && (
          <button
            onClick={handleFinish}
            className="w-full mt-4 text-muted-foreground text-sm hover:text-white transition-colors"
          >
            Pular introdução
          </button>
        )}
      </footer>
    </div>
  );
};

export default AppOnboarding;
