import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Line, ComposedChart, Bar } from 'recharts';
import { TrendingUp } from 'lucide-react';
import type { TimeProjection as TimeProjectionType } from './types';

interface TimeProjectionProps {
  projections: TimeProjectionType[];
  problemType: string;
  horizonDays: number;
}

export function TimeProjection({ projections, problemType, horizonDays }: TimeProjectionProps) {
  const { t } = useTranslation();
  const isClassification = problemType === 'classification';
  
  const formatValue = (val: number) => {
    if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
    return val.toFixed(0);
  };
  
  const formatCurrency = (val: number) => {
    if (val >= 1000000) return `R$ ${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `R$ ${(val / 1000).toFixed(1)}K`;
    return `R$ ${val.toFixed(0)}`;
  };
  
  const getHorizonLabel = () => {
    if (horizonDays <= 30) return t('businessDashboard.timeProjection.next30Days');
    if (horizonDays <= 60) return t('businessDashboard.timeProjection.next60Days');
    if (horizonDays <= 180) return t('businessDashboard.timeProjection.next6Months');
    return t('businessDashboard.timeProjection.next12Months');
  };

  if (projections.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            {t('businessDashboard.timeProjection.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            {t('businessDashboard.timeProjection.noData')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5" />
          {t('businessDashboard.timeProjection.title')}
        </CardTitle>
        <CardDescription>
          {isClassification 
            ? t('businessDashboard.timeProjection.classificationDesc', { horizon: getHorizonLabel() })
            : t('businessDashboard.timeProjection.regressionDesc', { horizon: getHorizonLabel() })
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={projections}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                dataKey="period" 
                tick={{ fontSize: 12 }}
              />
              <YAxis 
                yAxisId="left"
                tickFormatter={formatValue}
                tick={{ fontSize: 12 }}
              />
              <YAxis 
                yAxisId="right"
                orientation="right"
                tickFormatter={formatCurrency}
                tick={{ fontSize: 12 }}
              />
              <Tooltip 
                formatter={(value: number, name: string) => {
                  if (name === 'expectedEvents') {
                    return [formatValue(value), isClassification 
                      ? t('businessDashboard.timeProjection.expectedEvents')
                      : t('businessDashboard.timeProjection.projectedValue')
                    ];
                  }
                  return [formatCurrency(value), t('businessDashboard.timeProjection.financialImpact')];
                }}
              />
              <Bar 
                yAxisId="left"
                dataKey="expectedEvents" 
                fill="hsl(var(--primary))" 
                opacity={0.8}
                radius={[4, 4, 0, 0]}
                name="expectedEvents"
              />
              <Line 
                yAxisId="right"
                type="monotone" 
                dataKey="financialImpact" 
                stroke="hsl(var(--chart-2))" 
                strokeWidth={2}
                dot={{ fill: 'hsl(var(--chart-2))', strokeWidth: 2 }}
                name="financialImpact"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        
        <div className="mt-4 flex items-center justify-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded bg-primary" />
            <span className="text-muted-foreground">
              {isClassification 
                ? t('businessDashboard.timeProjection.cumulativeEvents')
                : t('businessDashboard.timeProjection.cumulativeValue')
              }
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: 'hsl(var(--chart-2))' }} />
            <span className="text-muted-foreground">
              {t('businessDashboard.timeProjection.financialImpactLabel')}
            </span>
          </div>
        </div>
        
        <div className="mt-4 p-3 bg-muted/50 rounded-lg">
          <p className="text-sm text-muted-foreground">
            {t('businessDashboard.timeProjection.interpretation')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
