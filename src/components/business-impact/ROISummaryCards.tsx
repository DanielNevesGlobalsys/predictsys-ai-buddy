import { useTranslation } from 'react-i18next';
import { TrendingUp, DollarSign, Users, Target, Calculator, Percent } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ROISummaryCardsProps {
  totalROI: {
    completedActionsCount: number;
    totalCustomersImpacted: number;
    totalIncrementalRevenue: number;
    totalIncrementalProfit: number;
    totalCost: number;
    netROI: number;
    roiPercent: number;
  };
}

export function ROISummaryCards({ totalROI }: ROISummaryCardsProps) {
  const { t } = useTranslation();

  const formatCurrency = (value: number) => {
    if (Math.abs(value) >= 1000000) {
      return `R$ ${(value / 1000000).toFixed(1)}M`;
    } else if (Math.abs(value) >= 1000) {
      return `R$ ${(value / 1000).toFixed(0)}k`;
    }
    return new Intl.NumberFormat('pt-BR', { 
      style: 'currency', 
      currency: 'BRL',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatNumber = (value: number) => {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(1)}M`;
    } else if (value >= 1000) {
      return `${(value / 1000).toFixed(0)}k`;
    }
    return value.toLocaleString('pt-BR');
  };

  const cards = [
    {
      title: t('businessImpact.netROI'),
      value: formatCurrency(totalROI.netROI),
      description: t('businessImpact.netROIDescription'),
      icon: TrendingUp,
      color: totalROI.netROI > 0 ? 'text-green-600' : totalROI.netROI < 0 ? 'text-red-600' : 'text-muted-foreground',
      bgColor: totalROI.netROI > 0 ? 'bg-green-100 dark:bg-green-900/20' : totalROI.netROI < 0 ? 'bg-red-100 dark:bg-red-900/20' : 'bg-muted',
    },
    {
      title: t('businessImpact.roiPercent'),
      value: `${totalROI.roiPercent.toFixed(0)}%`,
      description: t('businessImpact.roiPercentDescription'),
      icon: Percent,
      color: totalROI.roiPercent > 0 ? 'text-green-600' : totalROI.roiPercent < 0 ? 'text-red-600' : 'text-muted-foreground',
      bgColor: totalROI.roiPercent > 0 ? 'bg-green-100 dark:bg-green-900/20' : totalROI.roiPercent < 0 ? 'bg-red-100 dark:bg-red-900/20' : 'bg-muted',
    },
    {
      title: t('businessImpact.incrementalRevenue'),
      value: formatCurrency(totalROI.totalIncrementalRevenue),
      description: t('businessImpact.incrementalRevenueDescription'),
      icon: DollarSign,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100 dark:bg-blue-900/20',
    },
    {
      title: t('businessImpact.totalCost'),
      value: formatCurrency(totalROI.totalCost),
      description: t('businessImpact.totalCostDescription'),
      icon: Calculator,
      color: 'text-orange-600',
      bgColor: 'bg-orange-100 dark:bg-orange-900/20',
    },
    {
      title: t('businessImpact.customersImpacted'),
      value: formatNumber(totalROI.totalCustomersImpacted),
      description: t('businessImpact.customersImpactedDescription'),
      icon: Users,
      color: 'text-purple-600',
      bgColor: 'bg-purple-100 dark:bg-purple-900/20',
    },
    {
      title: t('businessImpact.completedActions'),
      value: totalROI.completedActionsCount.toString(),
      description: t('businessImpact.completedActionsDescription'),
      icon: Target,
      color: 'text-indigo-600',
      bgColor: 'bg-indigo-100 dark:bg-indigo-900/20',
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      {cards.map((card, index) => (
        <TooltipProvider key={index}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Card className="cursor-help hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <div className={`p-1.5 rounded-md ${card.bgColor}`}>
                      <card.icon className={`w-4 h-4 ${card.color}`} />
                    </div>
                    {card.title}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${card.color}`}>
                    {card.value}
                  </div>
                </CardContent>
              </Card>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">{card.description}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ))}
    </div>
  );
}
