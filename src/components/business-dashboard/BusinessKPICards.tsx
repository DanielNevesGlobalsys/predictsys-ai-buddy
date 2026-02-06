import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  Users, 
  AlertTriangle, 
  Target, 
  DollarSign, 
  Database, 
  Clock,
  Info,
  TrendingUp,
  CheckCircle,
  AlertCircle,
  BarChart3
} from 'lucide-react';
import type { KPIData, DashboardFilters } from './types';
import { cn } from '@/lib/utils';

interface BusinessKPICardsProps {
  kpis: KPIData;
  problemType: string;
  viewMode: DashboardFilters['viewMode'];
}

export function BusinessKPICards({ kpis, problemType, viewMode }: BusinessKPICardsProps) {
  const { t } = useTranslation();
  const isClassification = problemType === 'classification';
  
  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };
  
  const formatCurrency = (num: number) => {
    if (Math.abs(num) >= 1000000) return `R$ ${(num / 1000000).toFixed(1)}M`;
    if (Math.abs(num) >= 1000) return `R$ ${(num / 1000).toFixed(1)}K`;
    return `R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };
  
  const getHealthBadge = () => {
    if (kpis.daysSinceUpdate === null) return null;
    if (kpis.daysSinceUpdate <= 1) return { label: t('businessDashboard.kpis.fresh'), color: 'text-green-600 bg-green-100', icon: CheckCircle };
    if (kpis.daysSinceUpdate <= 7) return { label: t('businessDashboard.kpis.recent'), color: 'text-yellow-600 bg-yellow-100', icon: Clock };
    return { label: t('businessDashboard.kpis.stale'), color: 'text-red-600 bg-red-100', icon: AlertCircle };
  };
  
  const healthBadge = getHealthBadge();

  type CardDef = {
    title: string;
    value: string;
    description: string;
    icon: typeof Users;
    color: string;
    bgColor: string;
    badge?: typeof healthBadge;
    show?: boolean;
  };

  const classificationCards: CardDef[] = [
    {
      title: t('businessDashboard.kpis.entitiesWithPrediction'),
      value: formatNumber(kpis.totalEntities),
      description: t('businessDashboard.kpis.entitiesDescription'),
      icon: Users,
      color: 'text-primary',
      bgColor: 'bg-primary/10'
    },
    {
      title: viewMode === 'risk' 
        ? t('businessDashboard.kpis.highRisk')
        : t('businessDashboard.kpis.highOpportunity'),
      value: formatNumber(kpis.highProbabilityCount),
      description: `${kpis.highProbabilityPercent.toFixed(1)}% ${t('businessDashboard.kpis.ofTotal')}`,
      icon: viewMode === 'risk' ? AlertTriangle : TrendingUp,
      color: viewMode === 'risk' ? 'text-destructive' : 'text-green-600',
      bgColor: viewMode === 'risk' ? 'bg-destructive/10' : 'bg-green-600/10',
    },
    {
      title: t('businessDashboard.kpis.expectedEvents'),
      value: formatNumber(kpis.expectedEvents),
      description: `${kpis.expectedEventsPercent.toFixed(1)}% ${t('businessDashboard.kpis.conversionRate')}`,
      icon: Target,
      color: 'text-secondary',
      bgColor: 'bg-secondary/10'
    },
    {
      title: t('businessDashboard.kpis.financialImpact'),
      value: formatCurrency(kpis.financialImpact),
      description: t('businessDashboard.kpis.estimatedImpact'),
      icon: DollarSign,
      color: 'text-accent',
      bgColor: 'bg-accent/10',
      show: kpis.financialImpact > 0
    },
    {
      title: t('businessDashboard.kpis.baseCoverage'),
      value: `${kpis.coveragePercent.toFixed(0)}%`,
      description: kpis.coveragePercent < 60 
        ? t('businessDashboard.kpis.lowCoverageWarning')
        : t('businessDashboard.kpis.coverageOk'),
      icon: Database,
      color: kpis.coveragePercent < 60 ? 'text-yellow-600' : 'text-green-600',
      bgColor: kpis.coveragePercent < 60 ? 'bg-yellow-600/10' : 'bg-green-600/10'
    },
    {
      title: t('businessDashboard.kpis.dataUpdate'),
      value: kpis.daysSinceUpdate !== null 
        ? kpis.daysSinceUpdate === 0 
          ? t('businessDashboard.kpis.today')
          : `${kpis.daysSinceUpdate}d`
        : '-',
      description: t('businessDashboard.kpis.lastUpdate'),
      icon: Clock,
      color: 'text-muted-foreground',
      bgColor: 'bg-muted',
      badge: healthBadge
    }
  ].filter(card => card.show !== false);

  const regressionCards: CardDef[] = [
    {
      title: t('businessDashboard.kpis.entitiesWithPrediction'),
      value: formatNumber(kpis.totalEntities),
      description: t('businessDashboard.kpis.regressionEntitiesDesc'),
      icon: Users,
      color: 'text-primary',
      bgColor: 'bg-primary/10'
    },
    {
      title: t('businessDashboard.kpis.projectedValue'),
      value: formatCurrency(kpis.predictedTotalValue),
      description: t('businessDashboard.kpis.projectedValueDesc'),
      icon: TrendingUp,
      color: 'text-green-600',
      bgColor: 'bg-green-600/10',
    },
    {
      title: t('businessDashboard.kpis.avgPredicted'),
      value: formatCurrency(kpis.predictedAvgValue),
      description: t('businessDashboard.kpis.avgPredictedDesc'),
      icon: BarChart3,
      color: 'text-secondary',
      bgColor: 'bg-secondary/10',
    },
    {
      title: t('businessDashboard.kpis.financialImpact'),
      value: formatCurrency(kpis.financialImpact),
      description: t('businessDashboard.kpis.estimatedImpact'),
      icon: DollarSign,
      color: 'text-accent',
      bgColor: 'bg-accent/10',
    },
    {
      title: t('businessDashboard.kpis.baseCoverage'),
      value: `${kpis.coveragePercent.toFixed(0)}%`,
      description: kpis.coveragePercent < 60 
        ? t('businessDashboard.kpis.lowCoverageWarning')
        : t('businessDashboard.kpis.coverageOk'),
      icon: Database,
      color: kpis.coveragePercent < 60 ? 'text-yellow-600' : 'text-green-600',
      bgColor: kpis.coveragePercent < 60 ? 'bg-yellow-600/10' : 'bg-green-600/10'
    },
    {
      title: t('businessDashboard.kpis.dataUpdate'),
      value: kpis.daysSinceUpdate !== null 
        ? kpis.daysSinceUpdate === 0 
          ? t('businessDashboard.kpis.today')
          : `${kpis.daysSinceUpdate}d`
        : '-',
      description: t('businessDashboard.kpis.lastUpdate'),
      icon: Clock,
      color: 'text-muted-foreground',
      bgColor: 'bg-muted',
      badge: healthBadge
    }
  ];

  const cards = isClassification ? classificationCards : regressionCards;

  return (
    <div className={cn(
      "grid gap-4",
      "grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
    )}>
      {cards.map((card, index) => (
        <Card key={index} className="p-4 hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between mb-3">
            <div className={cn('p-2 rounded-lg', card.bgColor)}>
              <card.icon className={cn('w-5 h-5', card.color)} />
            </div>
            <Tooltip>
              <TooltipTrigger>
                <Info className="w-4 h-4 text-muted-foreground/50 hover:text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="max-w-xs text-sm">{card.description}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          
          <div className="space-y-1">
            <p className="text-2xl font-bold">{card.value}</p>
            <p className="text-xs text-muted-foreground line-clamp-2">{card.title}</p>
          </div>
          
          {card.badge && (
            <div className={cn('mt-2 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full', card.badge.color)}>
              <card.badge.icon className="w-3 h-3" />
              {card.badge.label}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
