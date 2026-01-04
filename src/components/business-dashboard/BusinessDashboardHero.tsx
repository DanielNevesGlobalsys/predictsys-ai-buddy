import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, Users, AlertTriangle, ShoppingCart, CreditCard, DollarSign, BarChart3 } from 'lucide-react';
import { PROBLEM_CONTEXT_LABELS } from './types';

interface BusinessDashboardHeroProps {
  problemContext: string | null;
  problemType: string;
  horizonDays: number;
}

export function BusinessDashboardHero({ problemContext, problemType, horizonDays }: BusinessDashboardHeroProps) {
  const { t } = useTranslation();
  
  const getContextIcon = () => {
    switch (problemContext) {
      case 'churn': return <Users className="w-8 h-8" />;
      case 'propensao_compra': return <ShoppingCart className="w-8 h-8" />;
      case 'inadimplencia': return <AlertTriangle className="w-8 h-8" />;
      case 'demanda': return <TrendingUp className="w-8 h-8" />;
      case 'ltv': return <DollarSign className="w-8 h-8" />;
      case 'credito': return <CreditCard className="w-8 h-8" />;
      default: return <BarChart3 className="w-8 h-8" />;
    }
  };
  
  const contextLabels = problemContext && PROBLEM_CONTEXT_LABELS[problemContext] 
    ? {
        title: t(PROBLEM_CONTEXT_LABELS[problemContext].title),
        subtitle: t(PROBLEM_CONTEXT_LABELS[problemContext].subtitle)
      }
    : {
        title: t('businessDashboard.hero.defaultTitle'),
        subtitle: t('businessDashboard.hero.defaultSubtitle')
      };
  
  const problemTypeLabel = problemType === 'classification' 
    ? t('businessDashboard.hero.classification')
    : problemType === 'regression'
    ? t('businessDashboard.hero.regression')
    : t('businessDashboard.hero.timeSeries');
  
  const horizonLabel = horizonDays <= 30 
    ? t('businessDashboard.hero.next30Days')
    : horizonDays <= 60 
    ? t('businessDashboard.hero.next60Days')
    : horizonDays <= 180 
    ? t('businessDashboard.hero.next6Months')
    : t('businessDashboard.hero.next12Months');

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-background border border-border p-8">
      <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2" />
      <div className="absolute bottom-0 left-0 w-48 h-48 bg-secondary/5 rounded-full translate-y-1/2 -translate-x-1/2" />
      
      <div className="relative z-10 flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center text-primary-foreground">
              {getContextIcon()}
            </div>
            <div>
              <h1 className="text-3xl font-display font-bold">
                {t('businessDashboard.hero.title')}
              </h1>
              <p className="text-lg text-muted-foreground mt-1">
                {contextLabels.subtitle}
              </p>
            </div>
          </div>
        </div>
        
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="text-sm px-3 py-1">
            {problemTypeLabel}
          </Badge>
          <Badge variant="outline" className="text-sm px-3 py-1">
            {horizonLabel}
          </Badge>
        </div>
      </div>
    </div>
  );
}
